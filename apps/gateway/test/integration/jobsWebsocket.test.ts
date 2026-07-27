import { getAdminPrisma } from "@cloudmesh/db";
import { createJobWorker } from "@cloudmesh/jobs";
import type { Worker } from "bullmq";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildJobRegistry } from "../../src/modules/jobs/handlers.js";
import { buildApp } from "../../src/app.js";
import { createTestApiKey, resetAll } from "./helpers.js";

const admin = getAdminPrisma();
const workerRedis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

/** Collects WebSocket messages until the socket closes or a deadline hits.
 *  Uses a real listening server (not app.inject, which can't do WS). */
function collectMessages(
  url: string,
  timeoutMs = 10_000,
): Promise<{ messages: unknown[]; closeCode: number | undefined }> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    let closeCode: number | undefined;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({ messages, closeCode });
    }, timeoutMs);

    ws.onmessage = (ev) => {
      try {
        messages.push(JSON.parse(String(ev.data)));
      } catch {
        messages.push(String(ev.data));
      }
    };
    ws.onclose = (ev) => {
      closeCode = ev.code;
      clearTimeout(timer);
      resolve({ messages, closeCode });
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ messages, closeCode });
    };
  });
}

describe("WebSocket job progress (Phase 9)", () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let worker: Worker | undefined;

  beforeAll(async () => {
    app = await buildApp();
    // A real listening socket — WebSockets can't go through app.inject().
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `ws://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    if (app) await app.close();
    await workerRedis.quit();
  });
  beforeEach(async () => {
    await resetAll(app);
  });
  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
  });

  async function submitJob(rawKey: string, texts: string[]): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: { type: "batch_embeddings", payload: { texts } },
    });
    return res.json().job_id as string;
  }

  describe("auth", () => {
    it("rejects a connection with no API key", async () => {
      const { rawKey } = await createTestApiKey();
      const jobId = await submitJob(rawKey, ["x"]);

      const { closeCode } = await collectMessages(`${baseUrl}/ws/jobs/${jobId}`, 4000);
      expect(closeCode).toBe(4401);
    });

    it("rejects a connection with an invalid API key", async () => {
      const { rawKey } = await createTestApiKey();
      const jobId = await submitJob(rawKey, ["x"]);

      const { closeCode } = await collectMessages(
        `${baseUrl}/ws/jobs/${jobId}?api_key=cm_live_not-a-real-key`,
        4000,
      );
      expect(closeCode).toBe(4401);
    });

    it("never streams another org's job, closing as not-found rather than confirming it exists", async () => {
      const orgA = await createTestApiKey("WS Org A");
      const orgB = await createTestApiKey("WS Org B");
      const jobId = await submitJob(orgA.rawKey, ["secret"]);

      const { closeCode, messages } = await collectMessages(
        `${baseUrl}/ws/jobs/${jobId}?api_key=${orgB.rawKey}`,
        4000,
      );
      expect(closeCode).toBe(4404);
      expect(messages).toEqual([]);
    });

    it("closes as not-found for a job id that doesn't exist at all", async () => {
      const { rawKey } = await createTestApiKey();
      const { closeCode } = await collectMessages(
        `${baseUrl}/ws/jobs/00000000-0000-4000-8000-000000000000?api_key=${rawKey}`,
        4000,
      );
      // Same code as the cross-tenant case above — a probe can't tell the
      // two apart.
      expect(closeCode).toBe(4404);
    });
  });

  describe("streaming", () => {
    it("sends the current state immediately on connect", async () => {
      const { rawKey } = await createTestApiKey();
      const jobId = await submitJob(rawKey, ["x"]);

      const { messages } = await collectMessages(
        `${baseUrl}/ws/jobs/${jobId}?api_key=${rawKey}`,
        2500,
      );
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages[0]).toMatchObject({ jobId, status: "QUEUED", progress: 0 });
    });

    it("streams real progress updates through to completion", async () => {
      const { rawKey } = await createTestApiKey();
      const jobId = await submitJob(rawKey, ["a", "b", "c", "d", "e"]);

      // Connect first, then start the worker, so the stream captures the
      // whole run rather than racing it.
      const collecting = collectMessages(`${baseUrl}/ws/jobs/${jobId}?api_key=${rawKey}`, 12_000);
      worker = createJobWorker(workerRedis, buildJobRegistry(app.embeddings, app.models), {
        concurrency: 2,
        db: app.db,
      });

      const { messages, closeCode } = await collecting;
      const statuses = messages.map((m) => (m as { status: string }).status);

      expect(statuses).toContain("RUNNING");
      expect(statuses).toContain("COMPLETED");
      // Server closes the socket once the job reaches a terminal state
      // rather than leaving a dead stream open.
      expect(closeCode).toBe(1000);

      const progresses = messages.map((m) => (m as { progress: number }).progress);
      expect(Math.max(...progresses)).toBe(100);
      // Real intermediate movement, not just 0 -> 100.
      expect(progresses.some((p) => p > 0 && p < 100)).toBe(true);
    });

    it("closes immediately for an already-finished job instead of hanging", async () => {
      const { rawKey } = await createTestApiKey();
      const jobId = await submitJob(rawKey, ["x"]);

      worker = createJobWorker(workerRedis, buildJobRegistry(app.embeddings, app.models), {
        concurrency: 2,
        db: app.db,
      });
      // Wait for it to actually finish before connecting.
      for (let i = 0; i < 60; i++) {
        const row = await admin.job.findUnique({ where: { id: jobId } });
        if (row?.status === "COMPLETED") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const { messages, closeCode } = await collectMessages(
        `${baseUrl}/ws/jobs/${jobId}?api_key=${rawKey}`,
        4000,
      );
      expect(messages[0]).toMatchObject({ status: "COMPLETED", progress: 100 });
      expect(closeCode).toBe(1000);
    });
  });
});
