import { liveStatsChannel } from "@cloudmesh/metrics";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { resetAll } from "./helpers.js";

const publisher = new Redis(process.env.REDIS_URL!);

/** A real listening server — WebSockets can't go through app.inject(), the
 *  same constraint apps/gateway's jobsWebsocket.test.ts documents. */
function collectMessages(
  url: string,
  timeoutMs = 3000,
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

async function registerAndLogin(app: FastifyInstance, email: string) {
  const registerRes = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { orgName: `Org for ${email}`, email, password: "correct-horse-1" },
  });
  const { orgId } = registerRes.json();
  const loginRes = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: "correct-horse-1" },
  });
  return { orgId, accessToken: loginRes.json().accessToken as string };
}

describe("WebSocket live stats (Phase 13)", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `ws://127.0.0.1:${port}`;
  });
  afterAll(async () => {
    if (app) await app.close();
    await publisher.quit();
  });
  beforeEach(async () => {
    await resetAll(app);
  });

  it("rejects a connection with no token", async () => {
    const { closeCode } = await collectMessages(`${baseUrl}/ws/live-stats`);
    expect(closeCode).toBe(4401);
  });

  it("rejects a connection with an invalid token", async () => {
    const { closeCode } = await collectMessages(`${baseUrl}/ws/live-stats?token=totally-made-up`);
    expect(closeCode).toBe(4401);
  });

  it("relays a message published on the org's own analytics channel", async () => {
    const { orgId, accessToken } = await registerAndLogin(app, "owner@acme.test");
    const collectPromise = collectMessages(`${baseUrl}/ws/live-stats?token=${accessToken}`, 2000);

    // Give the WS subscription time to attach before publishing.
    await new Promise((r) => setTimeout(r, 300));
    const payload = { rps: 4.2, p99: 812, errors: 1 };
    await publisher.publish(liveStatsChannel(orgId), JSON.stringify(payload));

    const { messages } = await collectPromise;
    expect(messages).toEqual([payload]);
  });

  it("never relays another org's live stats", async () => {
    const orgA = await registerAndLogin(app, "a@acme.test");
    const orgB = await registerAndLogin(app, "b@acme.test");
    const collectPromise = collectMessages(
      `${baseUrl}/ws/live-stats?token=${orgB.accessToken}`,
      1500,
    );

    await new Promise((r) => setTimeout(r, 300));
    await publisher.publish(
      liveStatsChannel(orgA.orgId),
      JSON.stringify({ rps: 99, p99: 1, errors: 0 }),
    );

    const { messages } = await collectPromise;
    expect(messages).toEqual([]);
  });
});
