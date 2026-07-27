import { JobRegistry, type JobHandler } from "@cloudmesh/jobs";
import { z } from "zod";
import { ValidationError } from "../../errors.js";
import type { EmbeddingProvider } from "../../providers/embeddings.js";
import type { ModelRegistry } from "../../providers/index.js";

/**
 * Job payload size is bounded well below Fastify's 1MB body limit: a job
 * payload is persisted to Postgres, echoed back on every GET /v1/jobs/:id,
 * and held in memory by a worker for the job's duration. An unbounded
 * payload is a cheap way to turn one authenticated request into sustained
 * memory and storage pressure across the whole worker pool.
 */
const MAX_BATCH_ITEMS = 100;
const MAX_TEXT_LENGTH = 10_000;

const batchEmbeddingsSchema = z.object({
  texts: z.array(z.string().min(1).max(MAX_TEXT_LENGTH)).min(1).max(MAX_BATCH_ITEMS),
});

const bulkChatSchema = z.object({
  model: z.string().min(1).max(200),
  prompts: z.array(z.string().min(1).max(MAX_TEXT_LENGTH)).min(1).max(MAX_BATCH_ITEMS),
});

/** Turns a Zod failure into the same ValidationError the HTTP layer already
 *  maps to a 400, so an invalid payload is rejected at submission time and
 *  never reaches the queue. */
function parseWith<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid job payload");
  }
  return parsed.data;
}

/**
 * Embeds a batch of texts — genuinely long-running work that doesn't belong
 * in a request/response cycle, which is exactly the case this phase exists
 * for. Uses the same EmbeddingProvider the semantic cache does, so it runs
 * for real against the mock embedder without provider credentials (and
 * against OpenAI when they're configured).
 */
export function batchEmbeddingsHandler(
  embeddings: EmbeddingProvider,
): JobHandler<z.infer<typeof batchEmbeddingsSchema>, { count: number; dimensions: number }> {
  return {
    type: "batch_embeddings",
    parsePayload: (raw) => parseWith(batchEmbeddingsSchema, raw),
    run: async (payload, ctx) => {
      const vectors: number[][] = [];
      for (const [i, text] of payload.texts.entries()) {
        vectors.push(await embeddings.embed(text));
        // Report after each item so a long batch shows real movement rather
        // than jumping 0 -> 100; this is what the WebSocket stream carries.
        await ctx.reportProgress(((i + 1) / payload.texts.length) * 100);
      }
      return { count: vectors.length, dimensions: vectors[0]?.length ?? 0 };
    },
  };
}

/**
 * Runs a list of prompts through the normal provider registry. Deliberately
 * NOT wired through the chat route's full pipeline (budget enforcement,
 * semantic cache, rate limiting): those are per-request HTTP concerns, and
 * silently re-entering them from a background worker would double-count
 * usage and consume the submitting org's rate-limit budget minutes after
 * their request already returned. Billing for job-driven provider calls is
 * a real gap and belongs to whichever phase makes async work billable —
 * flagged rather than half-built here.
 */
export function bulkChatHandler(
  models: ModelRegistry,
): JobHandler<z.infer<typeof bulkChatSchema>, { responses: string[] }> {
  return {
    type: "bulk_chat",
    parsePayload: (raw) => parseWith(bulkChatSchema, raw),
    run: async (payload, ctx) => {
      const resolved = models.resolve(payload.model);
      if (!resolved) {
        throw new ValidationError(`Unknown model: ${payload.model}`);
      }

      const responses: string[] = [];
      for (const [i, prompt] of payload.prompts.entries()) {
        const res = await resolved.provider.chat({
          model: resolved.providerModel,
          messages: [{ role: "user", content: prompt }],
          stream: false,
        });
        responses.push(res.message.content);
        await ctx.reportProgress(((i + 1) / payload.prompts.length) * 100);
      }
      return { responses };
    },
  };
}

export function buildJobRegistry(
  embeddings: EmbeddingProvider,
  models: ModelRegistry,
): JobRegistry {
  return new JobRegistry()
    .register(batchEmbeddingsHandler(embeddings))
    .register(bulkChatHandler(models));
}
