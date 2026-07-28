import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResendAdapter } from "../../src/providers/resend.js";

const BASE_URL = "https://api.resend.test";

let mockAgent: MockAgent;

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
});

function adapter(apiKey?: string) {
  return new ResendAdapter({ apiKey, baseUrl: BASE_URL, fromEmail: "alerts@cloudmesh.test" });
}

describe("ResendAdapter.sendEmail", () => {
  it("posts the email with the configured from address", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/emails", method: "POST" })
      .reply(200, { id: "email_1" });

    await expect(
      adapter("re_test").sendEmail({
        to: "owner@org.test",
        subject: "Job completed",
        html: "<p>Done</p>",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws without a network call when no API key is configured", async () => {
    await expect(adapter().sendEmail({ to: "a@b.test", subject: "x", html: "y" })).rejects.toThrow(
      /RESEND_API_KEY/,
    );
    mockAgent.assertNoPendingInterceptors();
  });

  it("throws on a non-2xx response", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/emails", method: "POST" })
      .reply(422, "invalid recipient");

    await expect(
      adapter("re_test").sendEmail({ to: "bad", subject: "x", html: "y" }),
    ).rejects.toThrow(/422/);
  });
});
