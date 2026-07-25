import { createHmac } from "node:crypto";
import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "../../src/errors.js";
import { StripeAdapter } from "../../src/providers/stripe.js";

const BASE_URL = "https://api.stripe.test";
const WEBHOOK_SECRET = "whsec_test_secret";

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
});

function adapter(overrides: Partial<{ apiKey: string; webhookSecret: string }> = {}) {
  return new StripeAdapter({ baseUrl: BASE_URL, ...overrides });
}

function sign(payload: string, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
}

describe("StripeAdapter.updateSubscription", () => {
  it("posts the new price as a form-encoded subscription item update", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({
        path: "/v1/subscriptions/sub_123",
        method: "POST",
        body: "items%5B0%5D%5Bid%5D=si_abc&items%5B0%5D%5Bprice%5D=price_pro",
      })
      .reply(200, { id: "sub_123" });

    await expect(
      adapter({ apiKey: "sk_test" }).updateSubscription("sub_123", "si_abc", "price_pro"),
    ).resolves.toBeUndefined();
  });

  it("throws ProviderError without a network call when no API key is configured", async () => {
    await expect(adapter().updateSubscription("sub_123", "si_abc", "price_pro")).rejects.toThrow(
      ProviderError,
    );
    mockAgent.assertNoPendingInterceptors();
  });

  it("throws ProviderError on a non-2xx response", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/subscriptions/sub_123", method: "POST" })
      .reply(402, "card declined");

    await expect(
      adapter({ apiKey: "sk_test" }).updateSubscription("sub_123", "si_abc", "price_pro"),
    ).rejects.toThrow(ProviderError);
  });
});

describe("StripeAdapter.reportUsage", () => {
  it("posts a meter event with the customer id and quantity", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/v1/billing/meter_events", method: "POST" })
      .reply(200, { id: "evt_1" });

    await expect(
      adapter({ apiKey: "sk_test" }).reportUsage("api_requests", "cus_123", 560, 1700000000),
    ).resolves.toBeUndefined();
  });

  it("throws ProviderError without a network call when no API key is configured", async () => {
    await expect(adapter().reportUsage("api_requests", "cus_123", 560)).rejects.toThrow(
      ProviderError,
    );
    mockAgent.assertNoPendingInterceptors();
  });
});

describe("StripeAdapter.verifyWebhookSignature", () => {
  it("accepts a correctly signed payload and returns the parsed event", () => {
    const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
    const timestamp = 1_700_000_000;
    const signature = sign(payload, WEBHOOK_SECRET, timestamp);
    const header = `t=${timestamp},v1=${signature}`;

    const event = adapter({ webhookSecret: WEBHOOK_SECRET }).verifyWebhookSignature(
      payload,
      header,
      300,
      timestamp,
    );
    expect(event).toEqual({ id: "evt_1", type: "invoice.paid", data: { object: {} } });
  });

  it("rejects a payload signed with the wrong secret", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const timestamp = 1_700_000_000;
    const signature = sign(payload, "wrong-secret", timestamp);
    const header = `t=${timestamp},v1=${signature}`;

    expect(() =>
      adapter({ webhookSecret: WEBHOOK_SECRET }).verifyWebhookSignature(
        payload,
        header,
        300,
        timestamp,
      ),
    ).toThrow(ProviderError);
  });

  it("rejects a tampered payload even with a validly-formatted signature", () => {
    const originalPayload = JSON.stringify({ id: "evt_1", amount: 100 });
    const timestamp = 1_700_000_000;
    const signature = sign(originalPayload, WEBHOOK_SECRET, timestamp);
    const header = `t=${timestamp},v1=${signature}`;
    const tamperedPayload = JSON.stringify({ id: "evt_1", amount: 999999 });

    expect(() =>
      adapter({ webhookSecret: WEBHOOK_SECRET }).verifyWebhookSignature(
        tamperedPayload,
        header,
        300,
        timestamp,
      ),
    ).toThrow(ProviderError);
  });

  it("rejects a timestamp outside the tolerance window (replay protection)", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const oldTimestamp = 1_700_000_000;
    const now = oldTimestamp + 301; // just past the 300s default tolerance
    const signature = sign(payload, WEBHOOK_SECRET, oldTimestamp);
    const header = `t=${oldTimestamp},v1=${signature}`;

    expect(() =>
      adapter({ webhookSecret: WEBHOOK_SECRET }).verifyWebhookSignature(payload, header, 300, now),
    ).toThrow(ProviderError);
  });

  it("rejects a missing signature header", () => {
    expect(() =>
      adapter({ webhookSecret: WEBHOOK_SECRET }).verifyWebhookSignature("{}", undefined),
    ).toThrow(ProviderError);
  });

  it("rejects a malformed signature header", () => {
    expect(() =>
      adapter({ webhookSecret: WEBHOOK_SECRET }).verifyWebhookSignature("{}", "not-a-real-header"),
    ).toThrow(ProviderError);
  });

  it("throws a 500-level ProviderError when no webhook secret is configured, distinct from a bad signature", () => {
    try {
      adapter().verifyWebhookSignature("{}", "t=1,v1=abc");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).statusCode).toBe(500);
    }
  });

  it("rejects a signature of a different length without crashing on timingSafeEqual", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const timestamp = 1_700_000_000;
    const header = `t=${timestamp},v1=deadbeef`; // valid hex, wrong length

    expect(() =>
      adapter({ webhookSecret: WEBHOOK_SECRET }).verifyWebhookSignature(
        payload,
        header,
        300,
        timestamp,
      ),
    ).toThrow(ProviderError);
  });
});
