import type { Prisma, PrismaClient } from "@cloudmesh/db";

/**
 * The publish side of the transactional outbox. As of Phase 10 the real
 * implementation is `NatsEventPublisher` (lib/natsPublisher.ts), backed by
 * NATS JetStream. The interface stayed the seam it was designed to be:
 * swapping the log stub for a real bus required no change to the poller,
 * the outbox table, or any transactional-insert call site.
 *
 * `eventId` is passed so the publisher can deduplicate. It's the outbox
 * row's own id — stable across retries, which is exactly what makes a
 * poller retry safe: republishing an event whose ack was lost can't create
 * a second copy downstream.
 */
export interface EventPublisher {
  publish(eventType: string, payload: unknown, eventId: string): Promise<void>;
}

/** Log-only publisher. No longer the default (Phase 10 wired up real NATS),
 *  but kept deliberately: it's what makes the poller's own retry/marking
 *  logic testable without a broker, and it's a usable fallback for a local
 *  run with no NATS container up. */
export class LogEventPublisher implements EventPublisher {
  constructor(private readonly log: (msg: string, fields: Record<string, unknown>) => void) {}

  async publish(eventType: string, payload: unknown, eventId: string): Promise<void> {
    this.log("outbox: publishing to log sink (no event bus configured)", {
      eventType,
      eventId,
      payload,
    });
  }
}

/** Writes the outbox row as part of an existing transaction — this is what
 *  makes the pattern transactional: the caller's own INSERT (usage_records,
 *  in Phase 7's case) and this row commit or roll back together. Must be
 *  called with the same `tx` the caller's other writes use, never a fresh
 *  top-level `db` call. */
export async function writeOutboxEvent(
  tx: Prisma.TransactionClient,
  eventType: string,
  payload: Prisma.InputJsonValue,
): Promise<void> {
  await tx.outboxEvent.create({ data: { eventType, payload } });
}

export interface PollResult {
  attempted: number;
  published: number;
}

/** Reads unpublished events (oldest first) and attempts to publish each.
 *  A publish failure leaves that row unpublished for the next poll —
 *  at-least-once delivery, matching the design doc; the publisher (or a
 *  future real one) is responsible for making its own writes idempotent on
 *  redelivery, not this poller. */
export async function pollOutbox(
  prisma: PrismaClient,
  publisher: EventPublisher,
  batchSize = 50,
): Promise<PollResult> {
  const pending = await prisma.outboxEvent.findMany({
    where: { publishedAt: null },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let published = 0;
  for (const event of pending) {
    try {
      // The outbox row id doubles as the event id: stable across retries,
      // so a republish after a lost ack dedupes downstream instead of
      // delivering the same event twice.
      await publisher.publish(event.eventType, event.payload, event.id);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { publishedAt: new Date() },
      });
      published++;
    } catch {
      // Leave unpublished; the next poll retries it. One event's publish
      // failure must not stop the rest of the batch from being attempted.
    }
  }

  return { attempted: pending.length, published };
}

export interface OutboxPollerHandle {
  stop: () => void;
}

/** Recursive setTimeout, not setInterval — guarantees polls never overlap
 *  even if one run takes longer than `intervalMs` (a slow/degraded DB
 *  shouldn't cause a pile of concurrent poll queries). */
export function startOutboxPoller(
  prisma: PrismaClient,
  publisher: EventPublisher,
  intervalMs: number,
  onError: (err: unknown) => void,
): OutboxPollerHandle {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      await pollOutbox(prisma, publisher);
    } catch (err) {
      onError(err);
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, intervalMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
