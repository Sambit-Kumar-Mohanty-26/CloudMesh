import { JobRegistry, type JobHandler, type JobHandlerContext } from "@cloudmesh/jobs";
import { z } from "zod";
import { ValidationError } from "../../errors.js";
import { recordUsageAndOutbox } from "../../lib/billing.js";
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
 * Bills one prompt's provider call against the submitting key.
 *
 * The requestId is derived from (jobRecordId, promptIndex) rather than the
 * provider's own response id, and that is the whole retry-safety story: a
 * job that dies on prompt 40 of 100 and is retried from scratch produces
 * byte-identical requestIds for prompts 0-39, so Phase 7's existing
 * UNIQUE(request_id) + ON CONFLICT DO NOTHING silently drops the repeats.
 * Using the provider's id would generate a fresh one per attempt and bill
 * the same work up to three times.
 *
 * A null apiKeyId (a row predating the column, or a since-deleted key)
 * skips billing rather than failing the job — usage_records.api_key_id is a
 * real foreign key and there is nothing valid to put there. The work still
 * completed; refusing to deliver it because it cannot be billed would be
 * the worse failure.
 */
async function billJobUsage(
  ctx: JobHandlerContext,
  model: string,
  promptIndex: number,
  usage: { promptTokens: number; completionTokens: number } | undefined,
): Promise<void> {
  if (!ctx.apiKeyId || !usage) return;
  await recordUsageAndOutbox(ctx.db, {
    orgId: ctx.orgId,
    apiKeyId: ctx.apiKeyId,
    model,
    usage,
    requestId: `job:${ctx.jobRecordId}:${promptIndex}`,
  });
}

/**
 * Runs a list of prompts through the normal provider registry, billing each
 * completed call (see billJobUsage). Deliberately still NOT wired through
 * the chat route's full pipeline (semantic cache, rate limiting): those are
 * per-request HTTP concerns, and re-entering them from a background worker
 * would consume the submitting org's rate-limit budget minutes after their
 * request already returned. Budget is checked once at submission instead
 * (see modules/jobs/routes.ts) — a long job can still overrun it, the same
 * bounded-overshoot trade-off Phase 7's billing lock already documents.
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
        await billJobUsage(ctx, resolved.providerModel, i, res.usage);
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
