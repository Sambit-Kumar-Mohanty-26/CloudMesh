import type { EventBus } from "@cloudmesh/events";
import type { EventPublisher } from "@cloudmesh/outbox";

/**
 * The real Phase 10 publisher: drains the Phase 7 transactional outbox onto
 * NATS JetStream.
 *
 * Deliberately thin. All the delivery guarantees live on either side of it
 * — Postgres guarantees the event was *recorded* atomically with the write
 * that caused it, and JetStream guarantees it's *persisted and delivered*
 * at least once. This class only bridges the two, so a publish failure
 * simply propagates and the poller leaves the row unpublished to retry.
 */
export class NatsEventPublisher implements EventPublisher {
  constructor(private readonly bus: EventBus) {}

  async publish(eventType: string, payload: unknown, eventId: string): Promise<void> {
    await this.bus.publish(eventType, payload, eventId);
  }
}
