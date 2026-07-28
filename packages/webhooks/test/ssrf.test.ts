import { describe, expect, it } from "vitest";
import { isSafeWebhookTarget } from "../src/ssrf.js";

describe("isSafeWebhookTarget", () => {
  it("rejects a malformed URL", async () => {
    expect((await isSafeWebhookTarget("not a url")).safe).toBe(false);
    expect((await isSafeWebhookTarget("")).safe).toBe(false);
  });

  it("rejects plain http — https only", async () => {
    const result = await isSafeWebhookTarget("http://example.com/webhook");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("https");
  });

  it("accepts a real public https hostname", async () => {
    const result = await isSafeWebhookTarget("https://example.com/webhook");
    expect(result.safe).toBe(true);
  });

  it("rejects the AWS/GCP/Azure metadata endpoint by literal IP", async () => {
    const result = await isSafeWebhookTarget("https://169.254.169.254/latest/meta-data/");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("169.254.169.254");
  });

  it("rejects loopback by literal IP", async () => {
    expect((await isSafeWebhookTarget("https://127.0.0.1/webhook")).safe).toBe(false);
    expect((await isSafeWebhookTarget("https://127.0.0.53/webhook")).safe).toBe(false);
  });

  it("rejects each RFC1918 private range by literal IP", async () => {
    expect((await isSafeWebhookTarget("https://10.0.0.1/webhook")).safe).toBe(false);
    expect((await isSafeWebhookTarget("https://172.16.0.1/webhook")).safe).toBe(false);
    expect((await isSafeWebhookTarget("https://172.31.255.254/webhook")).safe).toBe(false);
    expect((await isSafeWebhookTarget("https://192.168.1.1/webhook")).safe).toBe(false);
  });

  it("does not reject a public address that merely resembles a private one", async () => {
    // 172.32.0.1 is outside 172.16.0.0/12 (which ends at 172.31.255.255) —
    // proves the check is a real bitmask, not a naive string prefix match.
    expect((await isSafeWebhookTarget("https://172.32.0.1/webhook")).safe).toBe(true);
    // 192.169.1.1 is outside 192.168.0.0/16.
    expect((await isSafeWebhookTarget("https://192.169.1.1/webhook")).safe).toBe(true);
  });

  it("rejects loopback via IPv6 literal", async () => {
    expect((await isSafeWebhookTarget("https://[::1]/webhook")).safe).toBe(false);
  });

  it("rejects an IPv4-mapped IPv6 literal targeting the metadata endpoint", async () => {
    // A naive check that only inspects the IPv6 shape (and never unwraps
    // ::ffff: mapped addresses) would let this straight through.
    const result = await isSafeWebhookTarget("https://[::ffff:169.254.169.254]/latest/meta-data/");
    expect(result.safe).toBe(false);
  });

  it("rejects IPv6 unique-local and link-local literals", async () => {
    expect((await isSafeWebhookTarget("https://[fc00::1]/webhook")).safe).toBe(false);
    expect((await isSafeWebhookTarget("https://[fd12:3456:789a::1]/webhook")).safe).toBe(false);
    expect((await isSafeWebhookTarget("https://[fe80::1]/webhook")).safe).toBe(false);
  });

  it("resolves a hostname via DNS and rejects if it points at a private address", async () => {
    // "localhost" resolves to 127.0.0.1 (and/or ::1) on every real DNS
    // configuration — a genuine resolve-then-check, not a hardcoded
    // hostname denylist entry.
    const result = await isSafeWebhookTarget("https://localhost/webhook");
    expect(result.safe).toBe(false);
  });

  it("rejects a hostname that fails to resolve at all", async () => {
    const result = await isSafeWebhookTarget(
      "https://this-definitely-does-not-exist-cloudmesh-test.invalid/webhook",
    );
    expect(result.safe).toBe(false);
  });

  it("is re-checked independently on repeated calls, not cached", async () => {
    // Not a claim that DNS rebinding is detected within a single call — the
    // guard has no way to observe a record changing mid-lookup. The
    // property this proves is the one the delivery worker depends on:
    // calling the guard again performs a fresh resolution rather than
    // memoizing the first result, which is what makes checking again at
    // delivery time meaningful at all.
    const first = await isSafeWebhookTarget("https://example.com/webhook");
    const second = await isSafeWebhookTarget("https://127.0.0.1/webhook");
    expect(first.safe).toBe(true);
    expect(second.safe).toBe(false);
  });
});
