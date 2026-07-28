import { withTenant, type PrismaClient, type WebhookDeliveryStatus } from "@cloudmesh/db";
import type { Queue } from "bullmq";
import { generateWebhookSecret } from "./hmac.js";
import { isSafeWebhookTarget } from "./ssrf.js";
import { WEBHOOK_MAX_ATTEMPTS, type WebhookEventType, type WebhookJobData } from "./types.js";
import type { DeliveryAttemptResult } from "./deliver.js";

export class UnsafeWebhookUrlError extends Error {
  constructor(reason: string | undefined) {
    super(`Webhook URL failed the SSRF safety check${reason ? `: ${reason}` : ""}`);
    this.name = "UnsafeWebhookUrlError";
  }
}

export interface RegisterWebhookInput {
  orgId: string;
  url: string;
  eventTypes: string[];
}

export interface RegisteredWebhook {
  id: string;
  url: string;
  eventTypes: string[];
  /** Returned exactly once, at creation — same convention as an API key's
   *  raw value. Never returned by any subsequent read. */
  secret: string;
}

/**
 * Registration-time SSRF check — the design doc's "checked on POST
 * /webhooks (registration) — reject with 400 immediately". This does NOT
 * make the delivery-time check redundant: DNS can change between now and
 * the first delivery (see ssrf.ts), so `attemptDelivery` re-checks on every
 * single attempt regardless of what passed here.
 */
export async function registerWebhookEndpoint(
  db: PrismaClient,
  input: RegisterWebhookInput,
): Promise<RegisteredWebhook> {
  const check = await isSafeWebhookTarget(input.url);
  if (!check.safe) {
    throw new UnsafeWebhookUrlError(check.reason);
  }

  const secret = generateWebhookSecret();
  const endpoint = await withTenant(db, input.orgId, (tx) =>
    tx.webhookEndpoint.create({
      data: { orgId: input.orgId, url: input.url, secret, eventTypes: input.eventTypes },
    }),
  );

  return { id: endpoint.id, url: endpoint.url, eventTypes: endpoint.eventTypes, secret };
}

export async function listWebhookEndpoints(db: PrismaClient, orgId: string) {
  return withTenant(db, orgId, (tx) =>
    tx.webhookEndpoint.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        url: true,
        eventTypes: true,
        isActive: true,
        createdAt: true,
        // secret is deliberately excluded — never returned after creation.
      },
    }),
  );
}

export async function deleteWebhookEndpoint(
  db: PrismaClient,
  orgId: string,
  endpointId: string,
): Promise<boolean> {
  const result = await withTenant(db, orgId, (tx) =>
    tx.webhookEndpoint.deleteMany({ where: { id: endpointId, orgId } }),
  );
  return result.count > 0;
}

export async function listWebhookDeliveries(
  db: PrismaClient,
  orgId: string,
  endpointId: string,
  limit = 50,
) {
  return withTenant(db, orgId, (tx) =>
    tx.webhookDelivery.findMany({
      where: { orgId, webhookEndpointId: endpointId },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 200),
      include: { webhookEvent: { select: { eventType: true, payload: true, createdAt: true } } },
    }),
  );
}

export interface DispatchResult {
  eventId: string;
  deliveryCount: number;
}

/**
 * Fans a platform event out to every active, subscribed endpoint for its
 * org. Writes the `webhook_events` row (the design doc's "event sourcing
 * for all platform events") unconditionally, even when zero endpoints are
 * subscribed — the event still happened and is worth having a durable
 * record of; it just produces no deliveries.
 *
 * Called from apps/gateway's notification subscriber (see
 * modules/events/subscribers.ts), which is itself a NATS consumer — this
 * function does not touch NATS at all, keeping packages/webhooks
 * independent of the event-bus package.
 */
export async function dispatchWebhookEvent(
  db: PrismaClient,
  queue: Queue<WebhookJobData>,
  orgId: string,
  eventType: WebhookEventType,
  payload: unknown,
): Promise<DispatchResult> {
  const event = await withTenant(db, orgId, (tx) =>
    tx.webhookEvent.create({ data: { orgId, eventType, payload: payload as never } }),
  );

  const endpoints = await withTenant(db, orgId, (tx) =>
    tx.webhookEndpoint.findMany({
      where: { orgId, isActive: true, eventTypes: { has: eventType } },
    }),
  );

  for (const endpoint of endpoints) {
    const delivery = await withTenant(db, orgId, (tx) =>
      tx.webhookDelivery.create({
        data: { orgId, webhookEndpointId: endpoint.id, webhookEventId: event.id },
      }),
    );

    const jobData: WebhookJobData = {
      deliveryId: delivery.id,
      orgId,
      endpointId: endpoint.id,
      eventId: event.id,
      url: endpoint.url,
      secret: endpoint.secret,
      eventType,
      payload,
    };
    await queue.add("deliver", jobData, {
      attempts: WEBHOOK_MAX_ATTEMPTS,
      backoff: { type: "custom" },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  return { eventId: event.id, deliveryCount: endpoints.length };
}

/**
 * Records the outcome of one delivery attempt.
 *
 * `isFinalAttempt` is what distinguishes a delivery still awaiting its next
 * scheduled retry (stays PENDING) from one that has genuinely run out of
 * attempts (EXHAUSTED) — the same FAILED-vs-DEAD_LETTER distinction Phase
 * 9's job worker draws, for the identical reason: marking every failed
 * attempt as terminal would make an in-progress retry look like a finished
 * failure.
 */
export async function recordDeliveryAttempt(
  db: PrismaClient,
  orgId: string,
  deliveryId: string,
  attempt: number,
  result: DeliveryAttemptResult,
  isFinalAttempt: boolean,
): Promise<void> {
  const status: WebhookDeliveryStatus =
    result.outcome === "delivered"
      ? "DELIVERED"
      : result.outcome === "rejected"
        ? "FAILED"
        : isFinalAttempt
          ? "EXHAUSTED"
          : "PENDING";

  await withTenant(db, orgId, (tx) =>
    tx.webhookDelivery.updateMany({
      where: { id: deliveryId, orgId },
      data: {
        status,
        attempts: attempt,
        responseStatus: result.responseStatus,
        responseBody: result.responseBody,
        lastAttemptAt: new Date(),
      },
    }),
  );
}
