import { isSafeWebhookTarget, type SsrfCheckResult } from "./ssrf.js";
import { signWebhookPayload } from "./hmac.js";
import type { WebhookJobData } from "./types.js";

export type DeliveryOutcome = "delivered" | "rejected" | "retry";

export interface DeliveryAttemptResult {
  outcome: DeliveryOutcome;
  responseStatus?: number;
  /** Truncated — diagnostic only. An org's own endpoint can return an
   *  arbitrarily large body; this is not something to store in full. */
  responseBody?: string;
  errorMessage?: string;
}

const RESPONSE_BODY_MAX_LENGTH = 2000;
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * The send-and-classify half of a delivery attempt, WITHOUT the SSRF gate
 * — split out from `attemptDelivery` purely so each half has an honest unit
 * test. Real webhook targets are never loopback/private addresses (the
 * SSRF guard would reject them), but a local test HTTPS server necessarily
 * IS one — testing the 2xx/4xx/5xx/redirect classification logic here
 * means testing it against exactly that kind of server, which the combined
 * function's own SSRF gate would otherwise always block first.
 *
 * `attemptDelivery` is what the delivery worker actually calls; this is
 * never called directly outside a test.
 */
export async function sendAndClassify(job: WebhookJobData): Promise<DeliveryAttemptResult> {
  const body = JSON.stringify({
    event: job.eventType,
    data: job.payload,
    timestamp: new Date().toISOString(),
  });
  const signature = signWebhookPayload(body, job.secret);

  let response: Response;
  try {
    response = await fetch(job.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CloudMesh-Signature": signature,
      },
      body,
      // Design doc: "redirects are NOT followed automatically; a 3xx
      // response is logged, not chased." Node's fetch (unlike a browser's
      // cross-origin no-cors fetch) returns the real 3xx status and
      // headers under "manual" rather than an opaque redirect — verified
      // directly against a local server, not assumed from the spec text.
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (err) {
    // DNS failure mid-flight, connection refused, timeout — none of these
    // are the receiving endpoint explicitly rejecting the request, so
    // they're treated like a 5xx: transient, worth retrying.
    return { outcome: "retry", errorMessage: err instanceof Error ? err.message : "network error" };
  }

  const responseBody = (await response.text().catch(() => "")).slice(0, RESPONSE_BODY_MAX_LENGTH);

  if (response.status >= 200 && response.status < 300) {
    return { outcome: "delivered", responseStatus: response.status, responseBody };
  }
  if (response.status >= 300 && response.status < 400) {
    // A redirect means the org's endpoint moved or is misconfigured —
    // retrying the identical request won't fix that, so this is terminal
    // like a 4xx, not transient like a 5xx.
    return {
      outcome: "rejected",
      responseStatus: response.status,
      responseBody,
      errorMessage: "redirect response — not followed, not retried",
    };
  }
  if (response.status >= 400 && response.status < 500) {
    // Design doc: "4xx: do not retry (client error)".
    return { outcome: "rejected", responseStatus: response.status, responseBody };
  }
  // 5xx — design doc: "retry w/ backoff".
  return { outcome: "retry", responseStatus: response.status, responseBody };
}

/**
 * One full delivery attempt: the design doc's exact flow — SSRF-check,
 * build `{event, data, timestamp}`, sign with HMAC-SHA256, POST with
 * `X-CloudMesh-Signature`, classify the outcome.
 *
 * Re-runs the SSRF check immediately before every attempt, not just once at
 * registration — the entire reason Phase 11 requires a delivery-time check
 * (see ssrf.ts's module comment on DNS rebinding). A registration-time-only
 * check would make each individual delivery a live SSRF window again.
 *
 * `checkTarget` defaults to the real `isSafeWebhookTarget` and is only ever
 * overridden in tests: a genuine webhook target is never loopback (the
 * real guard would reject it), so proving the full gate-then-send
 * composition against a local test server needs a stand-in check for that
 * one URL — production code never supplies this parameter.
 */
export async function attemptDelivery(
  job: WebhookJobData,
  checkTarget: (url: string) => Promise<SsrfCheckResult> = isSafeWebhookTarget,
): Promise<DeliveryAttemptResult> {
  const ssrf = await checkTarget(job.url);
  if (!ssrf.safe) {
    return { outcome: "rejected", errorMessage: `blocked by SSRF guard: ${ssrf.reason}` };
  }
  return sendAndClassify(job);
}
