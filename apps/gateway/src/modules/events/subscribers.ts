import { Prisma, withTenant, type PrismaClient } from "@cloudmesh/db";
import {
  subjectFor,
  usageRecordedSchema,
  type EventEnvelope,
  type EventBus,
  type Subscription,
} from "@cloudmesh/events";
import { subscribe } from "@cloudmesh/events";
import { dispatchWebhookEvent, isWebhookEventType, type WebhookJobData } from "@cloudmesh/webhooks";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";

/**
 * The design doc's four subscribers. Each is a genuinely independent
 * consumer with its own durable name, so one being down or slow never
 * blocks the others — that's the whole point of the "before (synchronous
 * chain) / after (event-driven)" contrast in the spec.
 *
 * IMPORTANT — what these deliberately do NOT do: the design doc's diagram
 * shows `billing-service subscribes -> records usage`. This codebase does
 * not do that, on purpose. Phase 7 already writes `usage_records`
 * transactionally with the outbox row that produces this very event, which
 * is the entire point of the outbox pattern. Moving the billing write onto
 * at-least-once delivery would trade a database transaction for a network
 * guarantee, and a dropped message would become lost revenue. The event is
 * a NOTIFICATION that usage was recorded, not the mechanism that records
 * it. So each subscriber below does work that is genuinely downstream and
 * not already done elsewhere.
 *
 * Every subscriber that writes tenant data goes through `withTenant`: these
 * consume events for all orgs from one process, exactly like the Phase 9
 * job worker, so an unscoped write would either fail RLS or (worse) return
 * empty silently.
 */

export interface SubscriberDeps {
  bus: EventBus;
  db: PrismaClient;
  redis: Redis;
  onError?: (err: unknown, envelope?: EventEnvelope) => void;
}

/** Redis keys for the analytics rollups. Per-org and per-day so a query for
 *  "this org's spend today" is a single GET rather than a scan. */
function analyticsKey(orgId: string, day: string, metric: string): string {
  return `analytics:${orgId}:${day}:${metric}`;
}

function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Analytics — maintains cheap per-org daily rollups (requests, tokens,
 * cost) in Redis. Deliberately Redis counters rather than a new table, the
 * same deliberately-minimal choice as Phase 6's cache stats and Phase 8's
 * A/B counters: `usage_records` is already the durable source of truth, so
 * this exists only to make "today so far" a one-key read instead of an
 * aggregate scan.
 *
 * INCRBY is idempotent-unsafe by nature, so a redelivered event would
 * double-count. Accepted here and nowhere else: these are approximate
 * dashboards counters, explicitly not the billing figures (those come from
 * usage_records). If they ever need to be exact, they need the same
 * event-id dedup the audit subscriber uses.
 */
export async function startAnalyticsSubscriber(deps: SubscriberDeps): Promise<Subscription> {
  return subscribe(deps.bus, {
    durable: "analytics_service",
    filterSubject: subjectFor("usage.recorded"),
    onError: deps.onError,
    handler: async (payload) => {
      const event = usageRecordedSchema.parse(payload);
      const day = utcDay(new Date().toISOString());
      const totalTokens = event.promptTokens + event.completionTokens;

      await deps.redis
        .multi()
        .incr(analyticsKey(event.orgId, day, "requests"))
        .incrby(analyticsKey(event.orgId, day, "tokens"), totalTokens)
        // Cost is fractional; Redis counters are integers, so track it in
        // micro-dollars and divide on read rather than losing precision.
        .incrby(
          analyticsKey(event.orgId, day, "cost_micros"),
          Math.round(event.costUsd * 1_000_000),
        )
        .exec();
    },
  });
}

export interface DailyAnalytics {
  requests: number;
  tokens: number;
  costUsd: number;
}

export async function getDailyAnalytics(
  redis: Redis,
  orgId: string,
  day = utcDay(new Date().toISOString()),
): Promise<DailyAnalytics> {
  const [requests, tokens, costMicros] = await redis.mget(
    analyticsKey(orgId, day, "requests"),
    analyticsKey(orgId, day, "tokens"),
    analyticsKey(orgId, day, "cost_micros"),
  );
  return {
    requests: Number(requests ?? 0),
    tokens: Number(tokens ?? 0),
    costUsd: Number(costMicros ?? 0) / 1_000_000,
  };
}

/**
 * Audit — appends every platform event to an immutable, tenant-scoped log.
 *
 * This is the subscriber that has to be genuinely idempotent, because it
 * writes durable rows: `audit_log.event_id` is UNIQUE, so a JetStream
 * redelivery hits the constraint and is skipped rather than writing a
 * second entry. Catching P2002 (rather than checking-then-inserting) is
 * what makes that safe under concurrency — a check-first version races
 * itself when the same event is redelivered to two workers at once.
 */
export async function startAuditSubscriber(deps: SubscriberDeps): Promise<Subscription> {
  return subscribe(deps.bus, {
    durable: "audit_service",
    // Audits everything, not one event type — hence the wildcard.
    filterSubject: "cloudmesh.>",
    onError: deps.onError,
    handler: async (payload, envelope) => {
      const orgId = (payload as { orgId?: string }).orgId;
      // An event with no org can't be attributed to a tenant, and writing
      // it unscoped would defeat the RLS policy. Skipped rather than
      // guessed at.
      if (!orgId) return;

      try {
        await withTenant(deps.db, orgId, (tx) =>
          tx.auditLog.create({
            data: {
              orgId,
              eventId: envelope.eventId,
              eventType: envelope.eventType,
              payload: payload as Prisma.InputJsonValue,
            },
          }),
        );
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          return; // already audited — at-least-once redelivery, not an error
        }
        throw err;
      }
    },
  });
}

/**
 * Billing — reports metered usage to Stripe.
 *
 * This is the work that genuinely belongs off the request path: Phase 7
 * built `StripeAdapter.reportUsage()` (Billing Meter Events) but nothing
 * called it, because doing a third-party HTTP call inline would put
 * Stripe's availability on the critical path of every chat request. As an
 * event consumer it retries independently and a Stripe outage delays
 * reporting instead of failing user traffic.
 *
 * `reportUsage` is injected rather than imported: the Stripe adapter lives
 * in apps/api, and a consumer running in apps/gateway shouldn't reach
 * across apps. The consumer entry point supplies it (or omits it, when no
 * Stripe key is configured — the common case in this environment).
 */
export interface BillingSubscriberDeps extends SubscriberDeps {
  reportUsage?: (orgId: string, quantity: number, requestId: string) => Promise<void>;
}

export async function startBillingSubscriber(deps: BillingSubscriberDeps): Promise<Subscription> {
  return subscribe(deps.bus, {
    durable: "billing_service",
    filterSubject: subjectFor("usage.recorded"),
    onError: deps.onError,
    handler: async (payload) => {
      const event = usageRecordedSchema.parse(payload);
      if (!deps.reportUsage) return; // Stripe not configured — nothing to report to
      await deps.reportUsage(
        event.orgId,
        event.promptTokens + event.completionTokens,
        event.requestId,
      );
    },
  });
}

/**
 * Webhook dispatch — Phase 11's real implementation of what Phase 10's
 * placeholder notification subscriber deferred: "decides, does not
 * deliver" becomes "decides AND delivers, safely." Fans each of the six
 * real webhook-eligible event types out to every active, subscribed
 * `webhook_endpoint` for that org (see `@cloudmesh/webhooks`'
 * `dispatchWebhookEvent` for the SSRF-guarded, HMAC-signed, retried HTTP
 * delivery itself — this subscriber only decides WHICH events matter and
 * hands them off).
 *
 * Subscribes to the wildcard rather than one subject per event type so
 * adding a new webhook-eligible event type later doesn't mean touching
 * this subscriber's wiring — `isWebhookEventType` is the single gate that
 * decides what actually gets dispatched.
 */
export interface WebhookDispatchDeps extends SubscriberDeps {
  webhookQueue: Queue<WebhookJobData>;
}

export async function startWebhookDispatchSubscriber(
  deps: WebhookDispatchDeps,
): Promise<Subscription> {
  return subscribe(deps.bus, {
    durable: "webhook_dispatch_service",
    filterSubject: "cloudmesh.>",
    onError: deps.onError,
    handler: async (payload, envelope) => {
      if (!isWebhookEventType(envelope.eventType)) return;
      const orgId = (payload as { orgId?: string }).orgId;
      if (!orgId) return;
      await dispatchWebhookEvent(deps.db, deps.webhookQueue, orgId, envelope.eventType, payload);
    },
  });
}

/**
 * Email — the design doc's "Email notifications via Resend for job
 * completions, budget warnings, and API key events," which is exactly the
 * same six-event-type set the webhook dispatcher above acts on. A
 * deliberately coarse-grained recipient choice: the org's OWNER, not every
 * member — there's no per-user notification-preference system in this
 * schema, and emailing every member for every job completion would be
 * unusable noise for anything but the smallest orgs. A real preference
 * system is future scope, not something this phase's deliverable list
 * calls for.
 *
 * `sendEmail` is injected (defaults to a no-op) rather than importing
 * ResendAdapter directly, so a send failure — or Resend being unconfigured
 * entirely, the common case in this environment — never takes down the
 * subscriber; it's caught by `subscribe`'s own error handling exactly like
 * any other handler failure (nak, retried on redelivery).
 */
export interface EmailSubscriberDeps extends SubscriberDeps {
  sendEmail: (input: { to: string; subject: string; html: string }) => Promise<void>;
}

const EMAIL_SUBJECTS: Record<string, (payload: Record<string, unknown>) => string> = {
  "job.completed": (p) => `Job ${p.jobId} completed`,
  "job.failed": (p) => `Job ${p.jobId} failed`,
  "budget.warning": (p) =>
    `Budget warning: ${Math.round(Number(p.remainingFraction) * 100)}% remaining`,
  "budget.exceeded": () => "Monthly budget exceeded",
  "api_key.created": (p) => `New API key created (${p.keyPrefix})`,
  "api_key.revoked": (p) => `API key revoked (${p.keyPrefix})`,
};

export async function startEmailSubscriber(deps: EmailSubscriberDeps): Promise<Subscription> {
  return subscribe(deps.bus, {
    durable: "email_service",
    filterSubject: "cloudmesh.>",
    onError: deps.onError,
    handler: async (payload, envelope) => {
      const subjectFn = EMAIL_SUBJECTS[envelope.eventType];
      if (!subjectFn) return;
      const orgId = (payload as { orgId?: string }).orgId;
      if (!orgId) return;

      const owner = await withTenant(deps.db, orgId, (tx) =>
        tx.user.findFirst({ where: { orgId, role: "OWNER" }, select: { email: true } }),
      );
      if (!owner) return; // no owner on record — nothing to send to

      await deps.sendEmail({
        to: owner.email,
        subject: subjectFn(payload as Record<string, unknown>),
        html: `<p>${envelope.eventType}</p><pre>${JSON.stringify(payload, null, 2)}</pre>`,
      });
    },
  });
}
