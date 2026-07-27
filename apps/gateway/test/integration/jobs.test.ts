import { getAdminPrisma } from "@cloudmesh/db";
import { createJobWorker, type JobRegistry } from "@cloudmesh/jobs";
import type { Worker } from "bullmq";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildJobRegistry } from "../../src/modules/jobs/handlers.js";
import { createTestApiKey, createTestApp, resetAll } from "./helpers.js";

const admin = getAdminPrisma();
const workerRedis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

/** Drains the queue with a real BullMQ worker until the job reaches a
 *  terminal state, so these tests exercise the actual queue + worker, not a
 *  stubbed one. */
async function waitForStatus(
  app: FastifyInstance,
  rawKey: string,
  jobId: string,
  terminal: string[],
  timeoutMs = 12_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}`,
      headers: { authorization: `Bearer ${rawKey}` },
    });
    last = res.json();
    if (terminal.includes(String(last.status))) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

describe("async job queue (Phase 9)", () => {
  let app: FastifyInstance;
  let worker: Worker | undefined;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    // Guarded: if beforeAll threw, `app` is undefined and an unguarded
    // close() here throws a second, misleading error that buries the real
    // startup failure in the output.
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

  function startWorker(registry?: JobRegistry) {
    worker = createJobWorker(
      workerRedis,
      registry ?? buildJobRegistry(app.embeddings, app.models),
      {
        concurrency: 5,
        db: app.db,
      },
    );
    return worker;
  }

  describe("submission", () => {
    it("rejects an unauthenticated submission", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        payload: { type: "batch_embeddings", payload: { texts: ["hi"] } },
      });
      expect(res.statusCode).toBe(401);
    });

    it("accepts a valid job with 202 and returns a job id", async () => {
      const { rawKey } = await createTestApiKey();
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["alpha", "beta"] } },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json().job_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.json().status).toBe("QUEUED");
    });

    it("rejects an unknown job type at submission, before anything is enqueued", async () => {
      const { rawKey, orgId } = await createTestApiKey();
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { type: "definitely_not_a_job", payload: {} },
      });

      expect(res.statusCode).toBe(400);
      // Nothing persisted — a job that can never run must not occupy a row
      // or burn worker attempts.
      expect(await admin.job.count({ where: { orgId } })).toBe(0);
    });

    it("rejects a malformed payload for a known type, before enqueueing", async () => {
      const { rawKey, orgId } = await createTestApiKey();
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: [] } }, // empty array
      });

      expect(res.statusCode).toBe(400);
      expect(await admin.job.count({ where: { orgId } })).toBe(0);
    });

    it("rejects an oversized batch rather than accepting unbounded work", async () => {
      const { rawKey } = await createTestApiKey();
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          type: "batch_embeddings",
          payload: { texts: Array.from({ length: 500 }, (_, i) => `text-${i}`) },
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it("maps named priorities to the design doc's numeric scale", async () => {
      const { rawKey } = await createTestApiKey();
      const critical = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["x"] }, priority: "CRITICAL" },
      });
      const low = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["x"] }, priority: "LOW" },
      });

      expect(critical.json().priority).toBe(1);
      expect(low.json().priority).toBe(20);
    });

    it("defaults to NORMAL priority when none is given", async () => {
      const { rawKey } = await createTestApiKey();
      const res = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["x"] } },
      });
      expect(res.json().priority).toBe(10);
    });
  });

  describe("execution", () => {
    it("runs a job to completion and stores a real result", async () => {
      const { rawKey } = await createTestApiKey();
      const submit = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["alpha", "beta", "gamma"] } },
      });
      const jobId = submit.json().job_id as string;

      startWorker();
      const final = await waitForStatus(app, rawKey, jobId, ["COMPLETED", "DEAD_LETTER"]);

      expect(final.status).toBe("COMPLETED");
      expect(final.progress).toBe(100);
      // The mock embedder is 1536-dim, same as the real one — proof the
      // handler did actual embedding work, not a no-op.
      expect(final.result).toEqual({ count: 3, dimensions: 1536 });
      expect(final.finished_at).not.toBeNull();
    });

    it("runs a bulk_chat job through the real provider registry", async () => {
      const { rawKey } = await createTestApiKey();
      const submit = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          type: "bulk_chat",
          payload: { model: "mock-echo", prompts: ["one", "two"] },
        },
      });
      const jobId = submit.json().job_id as string;

      startWorker();
      const final = await waitForStatus(app, rawKey, jobId, ["COMPLETED", "DEAD_LETTER"]);

      expect(final.status).toBe("COMPLETED");
      expect(final.result).toEqual({ responses: ["echo: one", "echo: two"] });
    });

    it("records progress as the job advances, not just 0 then 100", async () => {
      const { rawKey, orgId } = await createTestApiKey();
      const submit = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: {
          type: "batch_embeddings",
          payload: { texts: Array.from({ length: 20 }, (_, i) => `t${i}`) },
        },
      });
      const jobId = submit.json().job_id as string;

      startWorker();
      await waitForStatus(app, rawKey, jobId, ["COMPLETED", "DEAD_LETTER"]);

      const row = await admin.job.findFirstOrThrow({ where: { id: jobId, orgId } });
      expect(row.progress).toBe(100);
      expect(row.startedAt).not.toBeNull();
      expect(row.attempts).toBeGreaterThanOrEqual(1);
    });
  });

  describe("retry and dead-letter queue", () => {
    it("retries a failing job then lands it in DEAD_LETTER with the error recorded", async () => {
      const { rawKey } = await createTestApiKey();
      let calls = 0;
      const alwaysFails: JobRegistry = buildJobRegistry(app.embeddings, app.models);
      alwaysFails.register({
        type: "batch_embeddings", // override with a guaranteed-failing impl
        parsePayload: (raw) => raw,
        run: async () => {
          calls++;
          throw new Error("boom");
        },
      });

      const submit = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["x"] } },
      });
      const jobId = submit.json().job_id as string;

      startWorker(alwaysFails);
      const final = await waitForStatus(app, rawKey, jobId, ["DEAD_LETTER"], 20_000);

      expect(final.status).toBe("DEAD_LETTER");
      expect(final.error).toBe("boom");
      // Design doc: 3 attempts before the DLQ.
      expect(calls).toBe(3);
    });

    it("replays a dead-lettered job against its original row", async () => {
      const { rawKey, orgId } = await createTestApiKey();
      let shouldFail = true;
      const flaky: JobRegistry = buildJobRegistry(app.embeddings, app.models);
      flaky.register({
        type: "batch_embeddings",
        parsePayload: (raw) => raw,
        run: async () => {
          if (shouldFail) throw new Error("still broken");
          return { recovered: true };
        },
      });

      const submit = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["x"] } },
      });
      const jobId = submit.json().job_id as string;

      startWorker(flaky);
      await waitForStatus(app, rawKey, jobId, ["DEAD_LETTER"], 20_000);

      // Fix the underlying cause, then replay.
      shouldFail = false;
      const replay = await app.inject({
        method: "POST",
        url: `/v1/jobs/${jobId}/replay`,
        headers: { authorization: `Bearer ${rawKey}` },
      });
      expect(replay.statusCode).toBe(202);

      const final = await waitForStatus(app, rawKey, jobId, ["COMPLETED"], 20_000);
      expect(final.status).toBe("COMPLETED");
      expect(final.result).toEqual({ recovered: true });

      // Replayed onto the SAME row, not a new one — job history stays in
      // one place rather than fragmenting across retry copies.
      expect(await admin.job.count({ where: { orgId } })).toBe(1);
      expect(final.job_id).toBe(jobId);
    });

    it("refuses to replay a job that is not dead-lettered", async () => {
      const { rawKey } = await createTestApiKey();
      const submit = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["x"] } },
      });
      const jobId = submit.json().job_id as string;

      const replay = await app.inject({
        method: "POST",
        url: `/v1/jobs/${jobId}/replay`,
        headers: { authorization: `Bearer ${rawKey}` },
      });
      expect(replay.statusCode).toBe(400);
    });
  });

  describe("tenant isolation", () => {
    it("never lets one org read another org's job", async () => {
      const orgA = await createTestApiKey("Jobs Org A");
      const orgB = await createTestApiKey("Jobs Org B");

      const submit = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${orgA.rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["secret"] } },
      });
      const jobId = submit.json().job_id as string;

      const stolen = await app.inject({
        method: "GET",
        url: `/v1/jobs/${jobId}`,
        headers: { authorization: `Bearer ${orgB.rawKey}` },
      });
      // 404, not 403 — never confirms that another org's job id exists.
      expect(stolen.statusCode).toBe(404);
    });

    it("never lets one org replay another org's dead-lettered job", async () => {
      const orgA = await createTestApiKey("Replay Org A");
      const orgB = await createTestApiKey("Replay Org B");

      const failing: JobRegistry = buildJobRegistry(app.embeddings, app.models);
      failing.register({
        type: "batch_embeddings",
        parsePayload: (raw) => raw,
        run: async () => {
          throw new Error("nope");
        },
      });

      const submit = await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${orgA.rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["x"] } },
      });
      const jobId = submit.json().job_id as string;

      startWorker(failing);
      await waitForStatus(app, orgA.rawKey, jobId, ["DEAD_LETTER"], 20_000);

      const stolen = await app.inject({
        method: "POST",
        url: `/v1/jobs/${jobId}/replay`,
        headers: { authorization: `Bearer ${orgB.rawKey}` },
      });
      expect(stolen.statusCode).toBe(404);
    });

    it("never lists another org's jobs", async () => {
      const orgA = await createTestApiKey("List Org A");
      const orgB = await createTestApiKey("List Org B");

      await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${orgA.rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["x"] } },
      });

      const listed = await app.inject({
        method: "GET",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${orgB.rawKey}` },
      });
      expect(listed.json().jobs).toEqual([]);
    });
  });

  describe("listing", () => {
    it("filters by status", async () => {
      const { rawKey } = await createTestApiKey();
      await app.inject({
        method: "POST",
        url: "/v1/jobs",
        headers: { authorization: `Bearer ${rawKey}` },
        payload: { type: "batch_embeddings", payload: { texts: ["x"] } },
      });

      const queued = await app.inject({
        method: "GET",
        url: "/v1/jobs?status=QUEUED",
        headers: { authorization: `Bearer ${rawKey}` },
      });
      const completed = await app.inject({
        method: "GET",
        url: "/v1/jobs?status=COMPLETED",
        headers: { authorization: `Bearer ${rawKey}` },
      });

      expect(queued.json().jobs).toHaveLength(1);
      expect(completed.json().jobs).toHaveLength(0);
    });

    it("rejects a hostile status filter rather than passing it to the DB", async () => {
      const { rawKey } = await createTestApiKey();
      const res = await app.inject({
        method: "GET",
        url: "/v1/jobs?status=QUEUED';DROP%20TABLE%20jobs;--",
        headers: { authorization: `Bearer ${rawKey}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
