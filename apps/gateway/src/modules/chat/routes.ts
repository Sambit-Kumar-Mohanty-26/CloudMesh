import {
  cacheOutcomesTotal,
  costUsdTotal,
  requestDurationMs,
  requestsTotal,
  tokensTotal,
  usageWriteFailuresTotal,
} from "@cloudmesh/metrics";
import { withSpan } from "@cloudmesh/telemetry";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Redis } from "ioredis";
import { ZodError } from "zod";
import { env } from "../../env.js";
import { ProviderError, ServiceUnavailableError, ValidationError } from "../../errors.js";
import {
  enforceBudget,
  maybePublishBudgetWarning,
  recordUsageAndOutbox,
} from "../../lib/billing.js";
import { getOrgFeatureFlags } from "../../lib/featureFlags.js";
import { getIdempotentReplay, storeIdempotentResult } from "../../lib/idempotency.js";
import { recordOrgRequestOutcome } from "../../lib/orgLiveStats.js";
import { getProviderStats } from "../../lib/providerStats.js";
import { withRequestDedup } from "../../lib/requestDedup.js";
import { callProviderResilientWithStats } from "../../lib/resilience.js";
import { resolveModelWithFallback } from "../../lib/resolveModel.js";
import { getAbStats, recordAbSelection } from "../../lib/routing.js";
import {
  computePromptHash,
  flushCache,
  getCacheStats,
  lookupCache,
  recordCacheOutcome,
  storeCache,
} from "../../lib/semanticCache.js";
import { requireApiKey } from "../../middleware/requireApiKey.js";
import { requireRateLimit } from "../../middleware/requireRateLimit.js";
import type { UnifiedChatChunk, UnifiedChatResponse } from "../../providers/types.js";
import { chatRequestSchema } from "./schemas.js";

function promptText(messages: { role: string; content: string }[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

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

/**
 * `cloudmesh_requests_total`/`cloudmesh_request_duration_ms` — recorded at
 * each of the route's actual exit points (idempotency replay, non-
 * streaming success/failure, streaming success/failure) rather than via a
 * generic Fastify `onResponse` hook: the streaming path calls
 * `reply.hijack()`, and Fastify's own docs say onResponse (like onSend)
 * does NOT fire for a hijacked reply — the same reason billing's
 * `recordUsageAndOutbox` is already called explicitly at each path instead
 * of from a hook. Malformed-request/budget-rejection paths that never
 * reach a resolved model (ValidationError before parsing, 402 from
 * enforceBudget) are deliberately NOT covered here — a rejected request
 * isn't a meaningful "chat request duration" sample, and their outcome is
 * already visible in the HTTP status code / error rate, not this
 * histogram.
 */
function recordRequestMetrics(
  redis: Redis,
  orgId: string,
  model: string,
  status: string,
  startedAtMs: number,
): void {
  const latencyMs = Date.now() - startedAtMs;
  requestsTotal.inc({ org: orgId, model, status });
  requestDurationMs.observe({ org: orgId, model }, latencyMs);
  // Phase 13's dashboard live-stats feed (WS /ws/live-stats in apps/api) —
  // "replay" is a successful response (from the idempotency cache), not an
  // error; everything else non-200 is.
  void recordOrgRequestOutcome(
    redis,
    orgId,
    latencyMs,
    status !== "200" && status !== "replay",
  ).catch(() => undefined);
}

/**
 * The design doc's own "usage_records write failures > 0" alert — see
 * runbooks/usage-write-failures.md. `recordUsageAndOutbox` can throw (a
 * real Postgres error, not just "duplicate requestId," which it already
 * handles via ON CONFLICT DO NOTHING) — without this wrapper, that error
 * would propagate straight to Fastify's generic error handler as an
 * anonymous 500, with no signal distinguishing "billing write failed" from
 * any other internal error. `usageWriteFailuresTotal` is incremented here,
 * specifically, before re-throwing unchanged — the request must still fail
 * (silently succeeding a response without recording usage would be the
 * actual revenue gap this alert exists to catch).
 */
async function recordUsageOrCountFailure(
  db: Parameters<typeof recordUsageAndOutbox>[0],
  params: Parameters<typeof recordUsageAndOutbox>[1],
): ReturnType<typeof recordUsageAndOutbox> {
  try {
    return await recordUsageAndOutbox(db, params);
  } catch (err) {
    usageWriteFailuresTotal.inc({ org: params.orgId });
    throw err;
  }
}

/**
 * Phase 12's structured-logging deliverable, matching the design doc's
 * example log line field-for-field (`org_id`, `model`, `latency_ms`,
 * `tokens`, `cost`, `cache_hit`, `provider`) — everything except
 * `trace_id`/`span_id`, which every log line gets automatically via
 * app.ts's pino `mixin` (see getTraceContext), not repeated here. Only
 * called at a genuinely completed request (non-streaming and streaming
 * success) — there's no meaningful tokens/cost/cache_hit reading for a
 * replay, a rejection, or a failed stream.
 */
function logChatCompletion(
  request: { log: { info: (fields: Record<string, unknown>, msg: string) => void } },
  fields: {
    orgId: string;
    model: string;
    provider: string;
    latencyMs: number;
    tokens: number;
    cost: number;
    cacheHit: boolean;
  },
): void {
  request.log.info(
    {
      org_id: fields.orgId,
      model: fields.model,
      provider: fields.provider,
      latency_ms: fields.latencyMs,
      tokens: fields.tokens,
      cost: fields.cost,
      cache_hit: fields.cacheHit,
    },
    "chat request completed",
  );
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
    const startedAtMs = Date.now();
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
    const apiKeyId = request.apiKeyCtx!.apiKeyId;
    const idempotencyKey = getIdempotencyKey(request);

    if (idempotencyKey) {
      const replay = await getIdempotentReplay(request.server.redis, orgId, idempotencyKey);
      if (replay) {
        reply.header("idempotent-replay", "true");
        reply.code(replay.statusCode);
        const replayedModel = (replay.body as { model?: string }).model ?? "unknown";
        recordRequestMetrics(request.server.redis, orgId, replayedModel, "replay", startedAtMs);
        return replay.body;
      }
    }

    // Semantic cache + request dedup are non-streaming-only (see below);
    // billing enforcement + usage recording apply to both — an unbilled
    // streamed request is a real revenue gap, not an acceptable
    // simplification the way cache/dedup's streaming skip is.
    const flags = await getOrgFeatureFlags(request.server.db, request.server.redis, orgId);

    // Throws BudgetExceededError (402) if the org has no budget left —
    // both AppError subclasses this throws, or that resolveModelWithFallback
    // throws below, are handled generically by app.ts's error handler.
    const budgetStatus = flags.billing_enforcement
      ? await withSpan("billing", { orgId }, () =>
          enforceBudget(request.server.db, request.server.redis, orgId, {
            ttlMs: env.BILLING_LOCK_TTL_MS,
            retries: env.BILLING_LOCK_RETRIES,
            retryDelayMs: env.BILLING_LOCK_RETRY_DELAY_MS,
          }),
        )
      : undefined;

    // Budget-constrained downgrade (auto-only, same rule as Phase 5's
    // provider fallback: an explicit model request is never silently
    // swapped for a different one, only "auto" resolution is steerable).
    const effectiveModelName =
      flags.billing_enforcement &&
      input.model === "auto" &&
      budgetStatus &&
      budgetStatus.remainingFraction < 0.05 &&
      env.BUDGET_CONSTRAINED_MODEL
        ? env.BUDGET_CONSTRAINED_MODEL
        : input.model;

    // Throws ValidationError (unknown model) or AllProvidersUnavailableError
    // (auto, every candidate's circuit open) — both AppError subclasses,
    // handled generically by app.ts's error handler.
    const routeDecision = await resolveModelWithFallback(
      request.server.models,
      request.server.redis,
      effectiveModelName,
      { preset: flags.routing_preset, abConfig: flags.ab_config },
    );
    const { resolved } = routeDecision;

    // Phase 8's "routing logs" deliverable — structured, not a DB table
    // (see lib/resolveModel.ts's RouteDecision doc comment for why).
    request.log.info(
      {
        orgId,
        requestedModel: input.model,
        selectedModel: resolved.providerModel,
        selectedProvider: resolved.provider.name,
        reason: routeDecision.reason,
        presetUsed: routeDecision.presetUsed,
        abVariant: routeDecision.abVariant,
        candidatesConsidered: routeDecision.candidatesConsidered,
      },
      "routing decision",
    );
    if (routeDecision.reason === "ab_variant") {
      await recordAbSelection(request.server.redis, orgId, routeDecision.abVariant!.model);
    }

    const providerReq = {
      model: resolved.providerModel,
      messages: input.messages,
      stream: input.stream,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
    };

    if (flags.billing_enforcement && budgetStatus) {
      await maybePublishBudgetWarning(request.server.db, orgId, budgetStatus);
    }

    if (!input.stream) {
      // Semantic cache + request dedup (Phase 6) are per-org opt-in
      // (organizations.feature_flags) and, like idempotency replay above,
      // deliberately non-streaming-only — see the streaming branch below
      // for why (same reasoning as idempotency's streaming simplification).
      const promptHash = computePromptHash(resolved.providerModel, input.messages);

      const runChat = (): Promise<UnifiedChatResponse> => {
        const doCall = () =>
          withSpan(
            "llm_provider",
            { model: resolved.providerModel, provider: resolved.provider.name },
            () =>
              callProviderResilientWithStats(request.server.redis, resolved.provider.name, () =>
                resolved.provider.chat(providerReq),
              ),
          );
        // The dedup key MUST include orgId — promptHash alone isn't
        // org-scoped, so two different orgs sending byte-identical prompts
        // must never be coalesced into sharing one response.
        return flags.request_dedup
          ? withRequestDedup(request.server.redis, `${orgId}:${promptHash}`, doCall, {
              leaderTtlSeconds: env.DEDUP_LEADER_TTL_SECONDS,
              followerWaitMs: env.DEDUP_FOLLOWER_WAIT_MS,
            })
          : doCall();
      };

      let response: UnifiedChatResponse;
      let fromCache = false;
      try {
        if (flags.semantic_cache) {
          const embedding = await request.server.embeddings.embed(promptText(input.messages));
          const cached = await withSpan(
            "semantic_cache",
            { orgId, model: resolved.providerModel },
            (span) =>
              lookupCache(request.server.db, orgId, resolved.providerModel, promptHash, embedding, {
                similarityThreshold: env.SEMANTIC_CACHE_SIMILARITY_THRESHOLD,
                ttlDays: flags.cache_ttl_days ?? env.SEMANTIC_CACHE_TTL_DAYS,
              }).then((result) => {
                span.setAttribute("hit", result !== null);
                return result;
              }),
          );
          if (cached) {
            await recordCacheOutcome(request.server.redis, orgId, "hit");
            cacheOutcomesTotal.inc({ outcome: "hit" });
            response = JSON.parse(cached) as UnifiedChatResponse;
            fromCache = true;
          } else {
            await recordCacheOutcome(request.server.redis, orgId, "miss");
            cacheOutcomesTotal.inc({ outcome: "miss" });
            response = await runChat();
            // Awaited (not fire-and-forget): a caller that immediately
            // repeats this request, or immediately flushes the cache, must
            // see a consistent, already-written state — not race an
            // in-flight INSERT. Errors are still swallowed so a failed
            // write degrades to "no caching this time," never a failed
            // response for work that already succeeded.
            await storeCache(
              request.server.db,
              orgId,
              resolved.providerModel,
              promptHash,
              embedding,
              JSON.stringify(response),
            ).catch((err: unknown) => {
              // Deliberately not logging `err` itself (or its .message) -
              // this query's parameters include the LLM's actual response
              // text, and some Prisma raw-query error paths echo bound
              // parameter values back in their message. Only the error's
              // class name is safe to record; the content never should be.
              //
              // CodeQL flags this as js/clear-text-logging because taint
              // reaches the catch from a query carrying prompt/response
              // text, and it doesn't model `.name` (an Error's class name —
              // "PrismaClientKnownRequestError", never content) as a
              // sanitizer. The narrowing to `.name` IS the mitigation; the
              // alert is a false positive that needs dismissing in the
              // GitHub UI (inline codeql[...] comments are not honored —
              // see packages/auth/src/apiKey.ts for the same situation).
              // If this ever changes to log more of `err`, the alert stops
              // being a false positive — re-check before widening it.
              // codeql[js/clear-text-logging]
              request.log.warn(
                { errName: err instanceof Error ? err.name : "unknown" },
                "failed to write semantic cache entry",
              );
            });
          }
        } else {
          response = await runChat();
        }
      } catch (err) {
        if (err instanceof ProviderError || err instanceof ServiceUnavailableError) {
          if (err.headers) reply.headers(err.headers);
          reply.code(err.statusCode);
          recordRequestMetrics(
            request.server.redis,
            orgId,
            resolved.providerModel,
            String(err.statusCode),
            startedAtMs,
          );
          return providerFailureBody(err);
        }
        throw err;
      }

      // A cache hit incurred no new provider cost — billing it again would
      // double-count the original request that populated the cache entry.
      let costUsd = 0;
      if (!fromCache) {
        const usageResult = await recordUsageOrCountFailure(request.server.db, {
          orgId,
          apiKeyId,
          model: resolved.providerModel,
          usage: response.usage,
          requestId: response.id,
        });
        costUsd = usageResult.costUsd;
        // Only for a genuinely new recording — a redelivered/duplicate
        // requestId (usageResult.recorded === false) already contributed
        // its tokens/cost the first time it was recorded.
        if (usageResult.recorded) {
          tokensTotal.inc(
            { org: orgId, model: resolved.providerModel, type: "prompt" },
            response.usage.promptTokens,
          );
          tokensTotal.inc(
            { org: orgId, model: resolved.providerModel, type: "completion" },
            response.usage.completionTokens,
          );
          costUsdTotal.inc({ org: orgId, model: resolved.providerModel }, usageResult.costUsd);
        }
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
      recordRequestMetrics(request.server.redis, orgId, resolved.providerModel, "200", startedAtMs);
      logChatCompletion(request, {
        orgId,
        model: resolved.providerModel,
        provider: resolved.provider.name,
        latencyMs: Date.now() - startedAtMs,
        tokens: response.usage.promptTokens + response.usage.completionTokens,
        cost: costUsd,
        cacheHit: fromCache,
      });
      return response;
    }

    // Streaming: pull the first chunk BEFORE committing to SSE headers, so
    // an immediate provider/circuit failure still comes back as an
    // ordinary JSON error instead of a half-open stream the client has no
    // clean way to detect as failed. Each retry attempt (inside
    // callProviderResilient) opens a BRAND NEW chatStream() call — reusing
    // one iterator across retries wouldn't work, since a generator that's
    // already thrown is done, not resumable. The routing stats latency
    // sample this records is therefore time-to-first-chunk, not full
    // stream duration — the same atomic, retryable unit resilience.ts
    // already treats streaming's circuit/retry logic as bounded to.
    let first: IteratorResult<UnifiedChatChunk>;
    let iterator: AsyncIterator<UnifiedChatChunk>;
    try {
      const attempt = await withSpan(
        "llm_provider",
        { model: resolved.providerModel, provider: resolved.provider.name, stream: true },
        () =>
          callProviderResilientWithStats(request.server.redis, resolved.provider.name, async () => {
            const it = resolved.provider.chatStream(providerReq)[Symbol.asyncIterator]();
            return { it, result: await it.next() };
          }),
      );
      iterator = attempt.it;
      first = attempt.result;
    } catch (err) {
      if (err instanceof ProviderError || err instanceof ServiceUnavailableError) {
        if (err.headers) reply.headers(err.headers);
        reply.code(err.statusCode);
        recordRequestMetrics(
          request.server.redis,
          orgId,
          resolved.providerModel,
          String(err.statusCode),
          startedAtMs,
        );
        return providerFailureBody(err);
      }
      throw err;
    }

    if (first.done) {
      reply.code(502);
      recordRequestMetrics(request.server.redis, orgId, resolved.providerModel, "502", startedAtMs);
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

    // Billing + idempotency bookkeeping happens BEFORE reply.raw.end(), not
    // after: once hijacked, Fastify's test injection (and any real client
    // watching for the connection to close) resolves on the raw response
    // ending, not on this handler's promise settling. Awaited work placed
    // after end() races the caller's next action — e.g. an immediate
    // idempotency-key replay could run before storeIdempotentResult has
    // actually written anything. A broken/partial stream must never be
    // recorded as a successful result — usage numbers from a stream that
    // failed before its final chunk aren't trustworthy (often still the
    // {0,0} default).
    if (!streamFailed) {
      const assembled: UnifiedChatResponse = {
        id: responseId,
        provider: resolved.provider.name,
        model: resolved.providerModel,
        message: { role: "assistant", content: fullText },
        finishReason,
        usage,
      };

      const usageResult = await recordUsageOrCountFailure(request.server.db, {
        orgId,
        apiKeyId,
        model: resolved.providerModel,
        usage,
        requestId: responseId,
      });
      if (usageResult.recorded) {
        tokensTotal.inc(
          { org: orgId, model: resolved.providerModel, type: "prompt" },
          usage.promptTokens,
        );
        tokensTotal.inc(
          { org: orgId, model: resolved.providerModel, type: "completion" },
          usage.completionTokens,
        );
        costUsdTotal.inc({ org: orgId, model: resolved.providerModel }, usageResult.costUsd);
      }

      if (idempotencyKey) {
        await storeIdempotentResult(
          request.server.redis,
          orgId,
          idempotencyKey,
          { statusCode: 200, body: assembled },
          env.IDEMPOTENCY_TTL_SECONDS,
        );
      }
      recordRequestMetrics(request.server.redis, orgId, resolved.providerModel, "200", startedAtMs);
      // Streaming never hits Phase 6's semantic cache (non-streaming-only,
      // see the feature flag check above) — cacheHit is always false here.
      logChatCompletion(request, {
        orgId,
        model: resolved.providerModel,
        provider: resolved.provider.name,
        latencyMs: Date.now() - startedAtMs,
        tokens: usage.promptTokens + usage.completionTokens,
        cost: usageResult.costUsd,
        cacheHit: false,
      });
    } else {
      recordRequestMetrics(
        request.server.redis,
        orgId,
        resolved.providerModel,
        "stream_failed",
        startedAtMs,
      );
    }

    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
  });

  fastify.get("/v1/models", async (request) => {
    return { models: await request.server.models.listModels() };
  });

  fastify.get("/v1/cache/stats", async (request) => {
    const orgId = request.apiKeyCtx!.orgId;
    return getCacheStats(request.server.redis, orgId);
  });

  fastify.delete("/v1/cache", async (request, reply) => {
    const orgId = request.apiKeyCtx!.orgId;
    const query = request.query as { keepModel?: string };
    const deleted = await flushCache(request.server.db, orgId, query.keepModel);
    reply.code(200);
    return { deleted };
  });

  // Phase 8's "real-time stats" deliverable — the same numbers the routing
  // engine itself scores candidates with, exposed for debugging/ops
  // visibility (e.g. "why did auto pick provider X"). Provider stats are
  // global (see lib/providerStats.ts), not org-scoped — every org's
  // traffic to a given provider shares one reading of that provider's
  // real-world performance.
  fastify.get("/v1/routing/stats", async (request) => {
    const providers = request.server.models.listProviderNames();
    const stats = await Promise.all(
      providers.map(
        async (provider) =>
          [provider, await getProviderStats(request.server.redis, provider)] as const,
      ),
    );
    return Object.fromEntries(stats);
  });

  fastify.get("/v1/routing/ab-stats", async (request) => {
    const orgId = request.apiKeyCtx!.orgId;
    const flags = await getOrgFeatureFlags(request.server.db, request.server.redis, orgId);
    if (!flags.ab_config) return {};
    return getAbStats(request.server.redis, orgId, flags.ab_config);
  });
}
