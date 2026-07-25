import { createHmac, timingSafeEqual } from "node:crypto";
import { ProviderError } from "../errors.js";

export interface StripeAdapterConfig {
  apiKey?: string;
  baseUrl: string;
  webhookSecret?: string;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes, Stripe's own documented default

/**
 * Hand-rolled against Stripe's documented REST API, not the `stripe` SDK —
 * consistent with every other external-provider adapter in this codebase
 * (OpenAI/Anthropic/Gemini/Ollama in apps/gateway all use plain fetch, no
 * vendor SDK either). Same "no live credentials in this environment"
 * caveat: unit-tested against undici MockAgent shaped to match Stripe's
 * documented API, not verified against a live account. The one exception
 * is `verifyWebhookSignature` — that's pure HMAC math with no network call,
 * so it IS verified for real (sign with a known secret, verify the same
 * signature), not just shape-tested.
 */
export class StripeAdapter {
  readonly name = "stripe";

  constructor(private readonly config: StripeAdapterConfig) {}

  private headers(): Record<string, string> {
    if (!this.config.apiKey) {
      throw new ProviderError("Stripe is not configured (missing STRIPE_API_KEY)", this.name);
    }
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
  }

  /** Plan change: updates a subscription to a new price (design doc: "Plan
   *  change -> stripe.subscriptions.update()"). `itemId` is the subscription
   *  item id being repriced, not the subscription id itself — Stripe prices
   *  attach to items, not subscriptions directly. */
  async updateSubscription(subscriptionId: string, itemId: string, priceId: string): Promise<void> {
    const res = await fetch(`${this.config.baseUrl}/v1/subscriptions/${subscriptionId}`, {
      method: "POST",
      headers: this.headers(),
      body: new URLSearchParams({ "items[0][id]": itemId, "items[0][price]": priceId }),
    });
    if (!res.ok) {
      throw new ProviderError(
        `Stripe subscription update failed: ${res.status} ${await res.text()}`,
        this.name,
      );
    }
  }

  /**
   * Usage report (design doc: "Usage report -> stripe.usageRecords.create()").
   * That literal API (subscription_items/{id}/usage_records) is Stripe's
   * now-deprecated legacy metered-billing endpoint; this implements the
   * same intent — reporting aggregated usage for metered billing — against
   * Stripe's current documented replacement, Billing Meter Events
   * (POST /v1/billing/meter_events), not the deprecated one.
   */
  async reportUsage(
    meterEventName: string,
    stripeCustomerId: string,
    quantity: number,
    timestamp: number = Math.floor(Date.now() / 1000),
  ): Promise<void> {
    const res = await fetch(`${this.config.baseUrl}/v1/billing/meter_events`, {
      method: "POST",
      headers: this.headers(),
      body: new URLSearchParams({
        event_name: meterEventName,
        "payload[stripe_customer_id]": stripeCustomerId,
        "payload[value]": String(quantity),
        timestamp: String(timestamp),
      }),
    });
    if (!res.ok) {
      throw new ProviderError(
        `Stripe usage report failed: ${res.status} ${await res.text()}`,
        this.name,
      );
    }
  }

  /**
   * Verifies Stripe's webhook signature scheme: the `Stripe-Signature`
   * header is `t=<unix ts>,v1=<hex hmac>[,v1=<hex hmac>...]`, computed as
   * HMAC-SHA256(webhookSecret, `${t}.${rawBody}`). Rejects (throws) on a
   * bad/missing signature OR a timestamp outside `toleranceSeconds` — the
   * latter is replay protection: a captured, still-validly-signed webhook
   * payload can't be replayed indefinitely.
   *
   * `rawBody` MUST be the exact, unparsed request body bytes — signing a
   * re-serialized JSON.stringify(JSON.parse(body)) can differ byte-for-byte
   * from what Stripe actually signed (key order, whitespace) and silently
   * break verification.
   */
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string | undefined,
    toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
    now: number = Math.floor(Date.now() / 1000),
  ): StripeWebhookEvent {
    if (!this.config.webhookSecret) {
      throw new ProviderError(
        "Stripe webhook secret is not configured (missing STRIPE_WEBHOOK_SECRET)",
        this.name,
        500,
      );
    }
    if (!signatureHeader) {
      throw new ProviderError("Missing Stripe-Signature header", this.name, 401);
    }

    const parts = Object.fromEntries(
      signatureHeader.split(",").map((kv) => {
        const [k, v] = kv.split("=");
        return [k, v] as [string, string];
      }),
    );
    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) {
      throw new ProviderError("Malformed Stripe-Signature header", this.name, 401);
    }

    if (Math.abs(now - Number(timestamp)) > toleranceSeconds) {
      throw new ProviderError(
        "Stripe webhook timestamp outside tolerance (possible replay)",
        this.name,
        401,
      );
    }

    const expected = createHmac("sha256", this.config.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf = Buffer.from(signature, "hex");
    // Constant-time comparison — a length mismatch would throw inside
    // timingSafeEqual, so check that first rather than let a malformed
    // signature crash instead of cleanly rejecting.
    const valid =
      expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
    if (!valid) {
      throw new ProviderError("Stripe webhook signature verification failed", this.name, 401);
    }

    return JSON.parse(rawBody) as StripeWebhookEvent;
  }
}
