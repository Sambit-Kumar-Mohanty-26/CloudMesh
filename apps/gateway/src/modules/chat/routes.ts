import type { FastifyInstance, FastifyReply } from "fastify";
import { ZodError } from "zod";
import { env } from "../../env.js";
import { ProviderError, ServiceUnavailableError, ValidationError } from "../../errors.js";
import { getIdempotentReplay, storeIdempotentResult } from "../../lib/idempotency.js";
import { callProviderResilient } from "../../lib/resilience.js";
import { resolveModelWithFallback } from "../../lib/resolveModel.js";
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

/** Shared shape for the "provider/circuit failed before anything streamed"
 *  responses, on both the streaming and non-streaming paths. */
function providerFailureBody(err: ProviderError | ServiceUnavailableError) {
  return {
    error: err.message,
    code: err.code,
    ...(err instanceof ProviderError ? { provider: err.provider } : {}),
  };
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

    // Throws ValidationError (unknown model) or AllProvidersUnavailableError
    // (auto, every candidate's circuit open) — both AppError subclasses,
    // handled generically by app.ts's error handler.
    const resolved = await resolveModelWithFallback(
      request.server.models,
      request.server.redis,
      input.model,
    );

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
        response = await callProviderResilient(request.server.redis, resolved.provider.name, () =>
          resolved.provider.chat(providerReq),
        );
      } catch (err) {
        if (err instanceof ProviderError || err instanceof ServiceUnavailableError) {
          if (err.headers) reply.headers(err.headers);
          reply.code(err.statusCode);
          return providerFailureBody(err);
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
    // an immediate provider/circuit failure still comes back as an
    // ordinary JSON error instead of a half-open stream the client has no
    // clean way to detect as failed. Each retry attempt (inside
    // callProviderResilient) opens a BRAND NEW chatStream() call — reusing
    // one iterator across retries wouldn't work, since a generator that's
    // already thrown is done, not resumable.
    let first: IteratorResult<UnifiedChatChunk>;
    let iterator: AsyncIterator<UnifiedChatChunk>;
    try {
      const attempt = await callProviderResilient(
        request.server.redis,
        resolved.provider.name,
        async () => {
          const it = resolved.provider.chatStream(providerReq)[Symbol.asyncIterator]();
          return { it, result: await it.next() };
        },
      );
      iterator = attempt.it;
      first = attempt.result;
    } catch (err) {
      if (err instanceof ProviderError || err instanceof ServiceUnavailableError) {
        if (err.headers) reply.headers(err.headers);
        reply.code(err.statusCode);
        return providerFailureBody(err);
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
