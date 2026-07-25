import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";
import { StripeAdapter } from "../providers/stripe.js";

declare module "fastify" {
  interface FastifyInstance {
    stripe: StripeAdapter;
  }
}

export default fp(async function stripePlugin(fastify: FastifyInstance) {
  fastify.decorate(
    "stripe",
    new StripeAdapter({
      apiKey: env.STRIPE_API_KEY,
      baseUrl: env.STRIPE_BASE_URL,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    }),
  );
});
