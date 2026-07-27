import { describe, expect, it } from "vitest";
import {
  EVENT_STREAM_NAME,
  EVENT_SUBJECT_WILDCARD,
  EVENT_TYPES,
  InvalidEventError,
  isKnownEventType,
  parseEvent,
  subjectFor,
} from "../src/schema.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const KEY = "22222222-2222-4222-8222-222222222222";

function envelope(eventType: string, payload: unknown) {
  return { eventId: "evt-1", eventType, timestamp: new Date().toISOString(), payload };
}

function validUsage(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    apiKeyId: KEY,
    model: "gpt-4o",
    promptTokens: 342,
    completionTokens: 218,
    costUsd: 0.0031,
    requestId: "req-1",
    ...overrides,
  };
}

describe("subjects", () => {
  it("maps an event type to its dotted subject", () => {
    expect(subjectFor("usage.recorded")).toBe("cloudmesh.usage.recorded");
    expect(subjectFor("request.completed")).toBe("cloudmesh.request.completed");
  });

  it("the stream wildcard covers every cloudmesh subject", () => {
    expect(EVENT_SUBJECT_WILDCARD).toBe("cloudmesh.>");
    for (const type of EVENT_TYPES) {
      expect(subjectFor(type).startsWith("cloudmesh.")).toBe(true);
    }
  });

  it("has a stable stream name", () => {
    expect(EVENT_STREAM_NAME).toBe("CLOUDMESH_EVENTS");
  });
});

describe("isKnownEventType", () => {
  it("accepts each declared type and rejects anything else without throwing", () => {
    for (const type of EVENT_TYPES) expect(isKnownEventType(type)).toBe(true);
    expect(isKnownEventType("made.up")).toBe(false);
    expect(isKnownEventType(undefined)).toBe(false);
    expect(isKnownEventType(null)).toBe(false);
    expect(isKnownEventType(42)).toBe(false);
    expect(isKnownEventType({})).toBe(false);
  });
});

describe("parseEvent", () => {
  it("parses a valid usage.recorded event", () => {
    const { envelope: env, payload } = parseEvent(envelope("usage.recorded", validUsage()));
    expect(env.eventType).toBe("usage.recorded");
    expect((payload as { model: string }).model).toBe("gpt-4o");
  });

  it("rejects a malformed envelope", () => {
    expect(() => parseEvent({ nope: true })).toThrow(InvalidEventError);
    expect(() => parseEvent(null)).toThrow(InvalidEventError);
    expect(() => parseEvent("a string")).toThrow(InvalidEventError);
  });

  it("rejects a payload that violates its event type's schema", () => {
    expect(() =>
      parseEvent(envelope("usage.recorded", validUsage({ orgId: "not-a-uuid" }))),
    ).toThrow(InvalidEventError);
    expect(() => parseEvent(envelope("usage.recorded", validUsage({ promptTokens: -5 })))).toThrow(
      InvalidEventError,
    );
    expect(() => parseEvent(envelope("usage.recorded", validUsage({ costUsd: -1 })))).toThrow(
      InvalidEventError,
    );
  });

  it("rejects a non-integer token count rather than silently truncating", () => {
    expect(() =>
      parseEvent(envelope("usage.recorded", validUsage({ completionTokens: 3.7 }))),
    ).toThrow(InvalidEventError);
  });

  it("passes through an unknown event type without validating its payload", () => {
    // A newer producer may emit types this consumer doesn't know yet — the
    // envelope is still valid, so this must not be treated as poison.
    const { envelope: env, payload } = parseEvent(envelope("future.event", { anything: 1 }));
    expect(env.eventType).toBe("future.event");
    expect(payload).toEqual({ anything: 1 });
  });

  it("accepts request.completed with and without its optional fields", () => {
    const base = {
      orgId: ORG,
      requestId: "req-1",
      model: "gpt-4o",
      promptTokens: 10,
      completionTokens: 20,
      costUsd: 0.001,
    };
    expect(() => parseEvent(envelope("request.completed", base))).not.toThrow();
    expect(() =>
      parseEvent(envelope("request.completed", { ...base, latencyMs: 820, cacheHit: false })),
    ).not.toThrow();
  });

  it("accepts budget.warning with a null budget (an unlimited org)", () => {
    expect(() =>
      parseEvent(
        envelope("budget.warning", {
          orgId: ORG,
          spentUsd: 5,
          budgetUsd: null,
          remainingFraction: 1,
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an oversized model string rather than passing it downstream", () => {
    expect(() =>
      parseEvent(envelope("usage.recorded", validUsage({ model: "x".repeat(500) }))),
    ).toThrow(InvalidEventError);
  });
});
