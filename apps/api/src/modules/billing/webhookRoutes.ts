import type { FastifyInstance } from "fastify";
import { ProviderError } from "../../errors.js";
import { processStripeWebhookEvent } from "./service.js";

/**
 * Deliberately NOT registered with `fastify-plugin` — this needs its own
 * encapsulated content-type parser (raw string body, not Fastify's default
 * JSON-parsed one) scoped to ONLY this route, since Stripe's signature
 * verification (see providers/stripe.ts) must sign the exact bytes Stripe
 * sent, not a re-serialized JSON.stringify(JSON.parse(body)) that can
 * differ byte-for-byte (key order, whitespace) and silently fail
 * verification. Wrapping with fastify-plugin would leak this parser to
 * every other route in the app, which must keep the normal JSON parser.
 */
export default async function billingWebhookRoutes(fastify: FastifyInstance) {
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  // No requireJwt — this endpoint is authenticated by Stripe's webhook
  // signature (see providers/stripe.ts's verifyWebhookSignature), not a
  // session. There is no session; Stripe's servers call this directly.
  //
  // That makes it the one publicly-reachable, unauthenticated route in this
  // service, so it needs its OWN rate limit rather than inheriting the
  // global baseline: signature verification is real HMAC work and the
  // handler does DB round-trips, both reachable by anyone who knows the
  // URL, before any credential check can reject them. The limit is
  // deliberately generous rather than tight — Stripe legitimately bursts
  // (an invoice run fans out many events), and a 429 here makes Stripe
  // retry rather than lose the event, so the cost of being too strict is
  // redelivery noise on real traffic, while the cost of having no limit at
  // all is an unauthenticated CPU/DB amplifier.
  const webhookRateLimit = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  fastify.post("/billing/webhook", webhookRateLimit, async (request, reply) => {
    const rawBody = request.body as string;
    const signatureHeader = request.headers["stripe-signature"] as string | undefined;

    let event;
    try {
      event = fastify.stripe.verifyWebhookSignature(rawBody, signatureHeader);
    } catch (err) {
      if (err instanceof ProviderError) {
        reply.code(err.statusCode);
        return { error: err.message, code: err.code };
      }
      throw err;
    }

    const result = await processStripeWebhookEvent({ db: fastify.db }, event);
    reply.code(200);
    return result;
  });
}
