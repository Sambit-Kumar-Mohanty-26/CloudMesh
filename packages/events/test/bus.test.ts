import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectEventBus, subscribe, type EventBus, type Subscription } from "../src/bus.js";
import { EVENT_STREAM_NAME, subjectFor } from "../src/schema.js";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

const ORG = "11111111-1111-4111-8111-111111111111";

function usagePayload(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    apiKeyId: "22222222-2222-4222-8222-222222222222",
    model: "gpt-4o",
    promptTokens: 342,
    completionTokens: 218,
    costUsd: 0.0031,
    requestId: `req-${randomUUID()}`,
    ...overrides,
  };
}

/** Waits for a condition rather than sleeping a fixed amount — delivery is
 *  fast but not synchronous, and a fixed sleep is how these tests get flaky. */
async function eventually<T>(fn: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("event bus (real NATS JetStream)", () => {
  let bus: EventBus;
  const subs: Subscription[] = [];

  beforeAll(async () => {
    bus = await connectEventBus({ servers: NATS_URL, name: "events-test" });
  });

  afterAll(async () => {
    for (const s of subs) await s.stop();
    if (bus) await bus.close();
  });

  beforeEach(async () => {
    // Purge between tests so a previous test's messages can't satisfy a
    // later assertion — the stream is durable by design, which makes
    // cross-test bleed the default rather than the exception.
    await bus.jsm.streams.purge(EVENT_STREAM_NAME).catch(() => undefined);
  });

  it("creates the stream idempotently — connecting twice is not an error", async () => {
    const second = await connectEventBus({ servers: NATS_URL, name: "events-test-2" });
    const info = await second.jsm.streams.info(EVENT_STREAM_NAME);
    expect(info.config.name).toBe(EVENT_STREAM_NAME);
    await second.close();
  });

  it("delivers a published event to a durable subscriber", async () => {
    const received: unknown[] = [];
    subs.push(
      await subscribe(bus, {
        durable: `test_deliver_${Date.now()}`,
        filterSubject: subjectFor("usage.recorded"),
        handler: async (payload) => {
          received.push(payload);
        },
      }),
    );

    const payload = usagePayload();
    await bus.publish("usage.recorded", payload, randomUUID());

    const got = await eventually(() => (received.length > 0 ? received : undefined));
    expect(got[0]).toMatchObject({ orgId: ORG, model: "gpt-4o", costUsd: 0.0031 });
  });

  it("fans the same event out to multiple independent subscribers", async () => {
    // The whole point of Limits (not WorkQueue) retention: one subscriber
    // acking must not consume the message out from under the others.
    const a: unknown[] = [];
    const b: unknown[] = [];
    const stamp = Date.now();
    subs.push(
      await subscribe(bus, {
        durable: `test_fanout_a_${stamp}`,
        filterSubject: subjectFor("usage.recorded"),
        handler: async (p) => {
          a.push(p);
        },
      }),
      await subscribe(bus, {
        durable: `test_fanout_b_${stamp}`,
        filterSubject: subjectFor("usage.recorded"),
        handler: async (p) => {
          b.push(p);
        },
      }),
    );

    await bus.publish("usage.recorded", usagePayload(), randomUUID());

    await eventually(() => (a.length > 0 ? a : undefined));
    await eventually(() => (b.length > 0 ? b : undefined));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("filters by subject — a consumer never sees other event types", async () => {
    const received: string[] = [];
    subs.push(
      await subscribe(bus, {
        durable: `test_filter_${Date.now()}`,
        filterSubject: subjectFor("budget.warning"),
        handler: async (_p, envelope) => {
          received.push(envelope.eventType);
        },
      }),
    );

    await bus.publish("usage.recorded", usagePayload(), randomUUID());
    await bus.publish(
      "budget.warning",
      { orgId: ORG, spentUsd: 9.1, budgetUsd: 10, remainingFraction: 0.09 },
      randomUUID(),
    );

    const got = await eventually(() => (received.length > 0 ? received : undefined));
    expect(got).toEqual(["budget.warning"]);
  });

  it("deduplicates a republished event id (safe outbox retry)", async () => {
    const received: unknown[] = [];
    subs.push(
      await subscribe(bus, {
        durable: `test_dedupe_${Date.now()}`,
        filterSubject: subjectFor("usage.recorded"),
        handler: async (p) => {
          received.push(p);
        },
      }),
    );

    const eventId = randomUUID();
    const payload = usagePayload();
    // The poller retrying a publish it wasn't sure landed must not create a
    // second copy.
    await bus.publish("usage.recorded", payload, eventId);
    await bus.publish("usage.recorded", payload, eventId);

    await eventually(() => (received.length > 0 ? received : undefined));
    await new Promise((r) => setTimeout(r, 600)); // allow a duplicate to arrive if it were going to
    expect(received).toHaveLength(1);
  });

  it("redelivers when a handler throws, then succeeds on retry (at-least-once)", async () => {
    let attempts = 0;
    const succeeded: unknown[] = [];
    subs.push(
      await subscribe(bus, {
        durable: `test_retry_${Date.now()}`,
        filterSubject: subjectFor("usage.recorded"),
        handler: async (p) => {
          attempts++;
          if (attempts < 2) throw new Error("transient failure");
          succeeded.push(p);
        },
        onError: () => undefined,
      }),
    );

    await bus.publish("usage.recorded", usagePayload(), randomUUID());

    await eventually(() => (succeeded.length > 0 ? succeeded : undefined), 15_000);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(succeeded).toHaveLength(1);
  });

  it("terminates a malformed message instead of redelivering it forever", async () => {
    const errors: unknown[] = [];
    let handlerCalls = 0;
    subs.push(
      await subscribe(bus, {
        durable: `test_poison_${Date.now()}`,
        filterSubject: subjectFor("usage.recorded"),
        handler: async () => {
          handlerCalls++;
        },
        onError: (err) => errors.push(err),
      }),
    );

    // Valid envelope, payload that violates the usage.recorded schema.
    await bus.publish("usage.recorded", { orgId: "not-a-uuid" }, randomUUID());

    await eventually(() => (errors.length > 0 ? errors : undefined));
    await new Promise((r) => setTimeout(r, 800));
    // Never reached the handler, and was not redelivered in a loop.
    expect(handlerCalls).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it("a durable consumer resumes from where it left off after restarting", async () => {
    const durable = `test_durable_${Date.now()}`;
    const first: unknown[] = [];
    const sub1 = await subscribe(bus, {
      durable,
      filterSubject: subjectFor("usage.recorded"),
      handler: async (p) => {
        first.push(p);
      },
    });

    await bus.publish("usage.recorded", usagePayload({ model: "before-restart" }), randomUUID());
    await eventually(() => (first.length > 0 ? first : undefined));
    await sub1.stop();

    // Published while the subscriber is DOWN — the durable must not miss it.
    await bus.publish("usage.recorded", usagePayload({ model: "while-down" }), randomUUID());

    const second: unknown[] = [];
    const sub2 = await subscribe(bus, {
      durable,
      filterSubject: subjectFor("usage.recorded"),
      handler: async (p) => {
        second.push(p);
      },
    });
    subs.push(sub2);

    const got = await eventually(() => (second.length > 0 ? second : undefined));
    expect((got[0] as { model: string }).model).toBe("while-down");
  });
});
