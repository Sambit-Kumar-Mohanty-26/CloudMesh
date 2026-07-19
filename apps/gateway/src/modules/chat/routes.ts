import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import { env } from "../../env.js";
import { ProviderError, ValidationError } from "../../errors.js";
import { getIdempotentReplay, storeIdempotentResult } from "../../lib/idempotency.js";
import { requireApiKey } from "../../middleware/requireApiKey.js";
import { requireRateLimit } from "../../middleware/requireRateLimit.js";
import type { UnifiedChatChunk, UnifiedChatResponse } from "../../providers/types.js";
import { chatRequestSchema } from "./schemas.js";

const IDEMPOTENCY_HEADER = "idempotency-key";

function getIdempotencyKey(request: { headers: Record<string, string | string[] | undefined> }) {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Resumes an already-partially-consumed async iterator, re-yielding the
 *  value already pulled from it before continuing — lets the route pull one
 *  chunk to check for an immediate error *before* committing to SSE, then
 *  hand the same stream to the normal write loop without losing that chunk. */
async function* resumeIterator<T>(
  first: IteratorResult<T>,
  iterator: AsyncIterator<T>,
): AsyncIterable<T> {
  if (first.done) return;
  yield first.value;
  for (;;) {
    const next = await iterator.next();
    if (next.done) return;
    yield next.value;
  }
}

function writeSSE(reply: FastifyReply, payload: unknown): void {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export default async function chatRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", requireApiKey);

  // Rate limiting only on the expensive, provider-cost-incurring route —
  // GET /v1/models is cheap/cached and doesn't need the same protection.
  fastify.post("/v1/chat", { preHandler: requireRateLimit }, async (request, reply) => {
    let input;
    try {
      input = chatRequestSchema.parse(request.body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError(err.issues[0]?.message ?? "Invalid request");
      }
      throw err;
    }

    // Guaranteed by the requireApiKey preHandler above.
    const orgId = request.apiKeyCtx!.orgId;
    const idempotencyKey = getIdempotencyKey(request);

    if (idempotencyKey) {
      const replay = await getIdempotentReplay(request.server.redis, orgId, idempotencyKey);
      if (replay) {
        reply.header("idempotent-replay", "true");
        reply.code(replay.statusCode);
        return replay.body;
      }
    }

    const resolved = request.server.models.resolve(input.model);
    if (!resolved) {
      throw new ValidationError(`Unknown model: ${input.model}`);
    }

    const providerReq = {
      model: resolved.providerModel,
      messages: input.messages,
      stream: input.stream,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
    };

    if (!input.stream) {
      let response: UnifiedChatResponse;
      try {
        response = await resolved.provider.chat(providerReq);
      } catch (err) {
        if (err instanceof ProviderError) {
          reply.code(502);
          return { error: err.message, code: err.code, provider: err.provider };
        }
        throw err;
      }

      if (idempotencyKey) {
        await storeIdempotentResult(
          request.server.redis,
          orgId,
          idempotencyKey,
          { statusCode: 200, body: response },
          env.IDEMPOTENCY_TTL_SECONDS,
        );
      }
      return response;
    }

    // Streaming: pull the first chunk BEFORE committing to SSE headers, so
    // an immediate provider error (bad key, connection refused, 4xx) still
    // comes back as an ordinary 502 JSON response instead of a half-open
    // stream the client has no clean way to detect as failed.
    const iterator = resolved.provider.chatStream(providerReq)[Symbol.asyncIterator]();
    let first: IteratorResult<UnifiedChatChunk>;
    try {
      first = await iterator.next();
    } catch (err) {
      if (err instanceof ProviderError) {
        reply.code(502);
        return { error: err.message, code: err.code, provider: err.provider };
      }
      throw err;
    }

    if (first.done) {
      reply.code(502);
      return { error: "Provider returned an empty stream", code: "PROVIDER_ERROR" };
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let fullText = "";
    let responseId = "";
    let finishReason: UnifiedChatResponse["finishReason"] = "stop";
    let usage: UnifiedChatResponse["usage"] = { promptTokens: 0, completionTokens: 0 };
    let streamFailed = false;

    try {
      for await (const chunk of resumeIterator(first, iterator)) {
        responseId = chunk.id;
        fullText += chunk.delta;
        if (chunk.done) {
          finishReason = chunk.finishReason ?? "stop";
          usage = chunk.usage ?? usage;
        }
        writeSSE(reply, chunk);
      }
    } catch (err) {
      streamFailed = true;
      writeSSE(reply, { error: err instanceof Error ? err.message : "stream error" });
    }

    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();

    // A broken/partial stream must never be cached as a successful result.
    if (idempotencyKey && !streamFailed) {
      const assembled: UnifiedChatResponse = {
        id: responseId,
        provider: resolved.provider.name,
        model: resolved.providerModel,
        message: { role: "assistant", content: fullText },
        finishReason,
        usage,
      };
      await storeIdempotentResult(
        request.server.redis,
        orgId,
        idempotencyKey,
        { statusCode: 200, body: assembled },
        env.IDEMPOTENCY_TTL_SECONDS,
      );
    }
  });

  fastify.get("/v1/models", async (request) => {
    return { models: await request.server.models.listModels() };
  });
}
