import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { env } from "../env.js";
import { buildEmbeddingProvider, type EmbeddingProvider } from "../providers/index.js";

declare module "fastify" {
  interface FastifyInstance {
    embeddings: EmbeddingProvider;
  }
}

export default fp(async function embeddingsPlugin(fastify: FastifyInstance) {
  fastify.decorate("embeddings", buildEmbeddingProvider(env));
});
