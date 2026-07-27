import {
  AckPolicy,
  connect,
  DeliverPolicy,
  RetentionPolicy,
  StringCodec,
  type ConsumerConfig,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
} from "nats";
import {
  EVENT_STREAM_NAME,
  EVENT_SUBJECT_WILDCARD,
  InvalidEventError,
  parseEvent,
  subjectFor,
  type EventEnvelope,
} from "./schema.js";

const codec = StringCodec();

export interface EventBus {
  publish(eventType: string, payload: unknown, eventId: string): Promise<void>;
  close(): Promise<void>;
  readonly connection: NatsConnection;
  readonly js: JetStreamClient;
  readonly jsm: JetStreamManager;
}

export interface ConnectOptions {
  servers: string;
  /** Distinguishes connections in NATS' own monitoring output — worth
   *  setting so `/connz` shows which process is which during an incident. */
  name?: string;
  maxReconnectAttempts?: number;
}

/**
 * Connects and ensures the stream exists. Idempotent: called by every
 * producer and consumer at startup, and creating an already-existing stream
 * with identical config is a no-op rather than an error, so there's no
 * separate "migrate the bus" step to forget.
 *
 * WorkQueue retention is deliberately NOT used — that deletes a message
 * once any one consumer acks it, which would mean the first subscriber to
 * ack destroys the message before the other three see it. Limits retention
 * keeps each message until it ages/sizes out, so all four subscribers get
 * an independent copy. This is the difference between a fan-out bus and a
 * work queue, and getting it wrong looks like "random subscribers miss
 * random events."
 */
export async function connectEventBus(opts: ConnectOptions): Promise<EventBus> {
  const connection = await connect({
    servers: opts.servers,
    name: opts.name,
    maxReconnectAttempts: opts.maxReconnectAttempts ?? -1,
  });

  const jsm = await connection.jetstreamManager();
  await jsm.streams.add({
    name: EVENT_STREAM_NAME,
    subjects: [EVENT_SUBJECT_WILDCARD],
    retention: RetentionPolicy.Limits,
    max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days, in nanoseconds
  });

  const js = connection.jetstream();

  return {
    connection,
    js,
    jsm,
    async publish(eventType, payload, eventId) {
      const envelope: EventEnvelope = {
        eventId,
        eventType,
        timestamp: new Date().toISOString(),
        payload,
      };
      await js.publish(subjectFor(eventType), codec.encode(JSON.stringify(envelope)), {
        // JetStream dedupes on this within the stream's duplicate window,
        // so the outbox poller retrying a publish it isn't sure landed
        // can't create a second copy of the same event.
        msgID: eventId,
      });
    },
    async close() {
      await connection.drain();
    },
  };
}

export interface SubscriberHandler {
  (payload: unknown, envelope: EventEnvelope): Promise<void>;
}

export interface SubscribeOptions {
  /** Durable consumer name. Durable is the point: a subscriber that was
   *  down comes back and resumes from where it left off instead of missing
   *  everything that happened while it was gone. */
  durable: string;
  /** e.g. `cloudmesh.usage.recorded`, or a wildcard. */
  filterSubject: string;
  handler: SubscriberHandler;
  onError?: (err: unknown, envelope?: EventEnvelope) => void;
  maxDeliver?: number;
}

export interface Subscription {
  stop: () => Promise<void>;
}

/**
 * Starts a durable pull consumer.
 *
 * Ack semantics matter here and are easy to get subtly wrong:
 *  - handler succeeds        -> ack (done, never redelivered)
 *  - handler throws          -> nak (redeliver; a transient DB blip should
 *                              not silently drop a billing event)
 *  - message fails schema    -> term (never redeliver; it will fail
 *                              identically forever, and an endlessly
 *                              redelivered poison message starves the
 *                              consumer)
 */
export async function subscribe(bus: EventBus, opts: SubscribeOptions): Promise<Subscription> {
  const config: Partial<ConsumerConfig> = {
    durable_name: opts.durable,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    filter_subject: opts.filterSubject,
    max_deliver: opts.maxDeliver ?? 5,
  };

  // add() is idempotent for identical config, so a restarting consumer
  // reuses its existing durable (and therefore its position) rather than
  // starting over.
  await bus.jsm.consumers.add(EVENT_STREAM_NAME, config);
  const consumer = await bus.js.consumers.get(EVENT_STREAM_NAME, opts.durable);

  let stopped = false;
  const messages = await consumer.consume();

  const pump = (async () => {
    for await (const msg of messages) {
      if (stopped) break;
      let envelope: EventEnvelope | undefined;
      try {
        const raw: unknown = JSON.parse(codec.decode(msg.data));
        const parsed = parseEvent(raw);
        envelope = parsed.envelope;
        await opts.handler(parsed.payload, parsed.envelope);
        msg.ack();
      } catch (err) {
        if (err instanceof InvalidEventError || err instanceof SyntaxError) {
          // Poison message — terminate rather than redeliver forever.
          msg.term();
        } else {
          msg.nak();
        }
        opts.onError?.(err, envelope);
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      messages.stop();
      await pump.catch(() => undefined);
    },
  };
}
