import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attemptDelivery, sendAndClassify } from "../src/deliver.js";
import { verifyWebhookSignature } from "../src/hmac.js";
import type { WebhookJobData } from "../src/types.js";
import {
  readRequestBody,
  startTestHttpsServer,
  trustTestCert,
  type TestHttpsServerHandle,
} from "./helpers.js";

let restoreDispatcher: () => void;
let handle: TestHttpsServerHandle | undefined;

beforeEach(() => {
  restoreDispatcher = trustTestCert();
});
afterEach(async () => {
  restoreDispatcher();
  if (handle) {
    await handle.close();
    handle = undefined;
  }
});

function job(overrides: Partial<WebhookJobData> = {}): WebhookJobData {
  return {
    deliveryId: "delivery-1",
    orgId: "11111111-1111-4111-8111-111111111111",
    endpointId: "endpoint-1",
    eventId: "event-1",
    url: handle?.url ?? "https://unused.invalid/webhook",
    secret: "whsec_test_secret",
    eventType: "job.completed",
    payload: { jobId: "abc" },
    ...overrides,
  };
}

// Real webhook targets are never loopback/private (the SSRF guard would
// reject them), but a local test HTTPS server necessarily IS one — so the
// HTTP send-and-classify behavior is tested via `sendAndClassify`, which
// has no SSRF gate in front of it. `attemptDelivery`'s own SSRF gating is
// tested separately, below, against URLs that don't need a real server.
describe("sendAndClassify", () => {
  it("signs the exact request body it sends, verifiable by the receiver", async () => {
    let receivedSignature: string | undefined;
    let receivedBody = "";
    handle = await startTestHttpsServer((req, res) => {
      receivedSignature = req.headers["x-cloudmesh-signature"] as string;
      readRequestBody(req).then((body) => {
        receivedBody = body;
        res.writeHead(200);
        res.end("ok");
      });
    });

    const result = await sendAndClassify(job());
    expect(result.outcome).toBe("delivered");
    expect(verifyWebhookSignature(receivedBody, "whsec_test_secret", receivedSignature!)).toBe(
      true,
    );

    const parsed = JSON.parse(receivedBody);
    expect(parsed).toMatchObject({ event: "job.completed", data: { jobId: "abc" } });
    expect(parsed.timestamp).toBeDefined();
  });

  it("classifies a 2xx response as delivered", async () => {
    handle = await startTestHttpsServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const result = await sendAndClassify(job());
    expect(result.outcome).toBe("delivered");
    expect(result.responseStatus).toBe(204);
  });

  it("classifies a 4xx response as rejected (do not retry)", async () => {
    handle = await startTestHttpsServer((_req, res) => {
      res.writeHead(400);
      res.end("bad request");
    });
    const result = await sendAndClassify(job());
    expect(result.outcome).toBe("rejected");
    expect(result.responseStatus).toBe(400);
  });

  it("classifies a 5xx response as retry", async () => {
    handle = await startTestHttpsServer((_req, res) => {
      res.writeHead(503);
      res.end("unavailable");
    });
    const result = await sendAndClassify(job());
    expect(result.outcome).toBe("retry");
    expect(result.responseStatus).toBe(503);
  });

  it("classifies a redirect as rejected, and does NOT follow it", async () => {
    let redirectTargetHit = false;
    handle = await startTestHttpsServer((req, res) => {
      if (req.url === "/webhook") {
        res.writeHead(302, { Location: "https://localhost/elsewhere" });
        res.end();
      } else {
        redirectTargetHit = true;
        res.writeHead(200);
        res.end();
      }
    });

    const result = await sendAndClassify(job());
    expect(result.outcome).toBe("rejected");
    expect(result.responseStatus).toBe(302);
    expect(redirectTargetHit).toBe(false);
  });

  it("classifies a connection failure as retry, not a crash", async () => {
    // No server listening on this port at all.
    const result = await sendAndClassify(job({ url: "https://localhost:1/webhook" }));
    expect(result.outcome).toBe("retry");
    expect(result.errorMessage).toBeDefined();
  });

  it("truncates an oversized response body rather than storing it in full", async () => {
    handle = await startTestHttpsServer((_req, res) => {
      res.writeHead(200);
      res.end("x".repeat(50_000));
    });
    const result = await sendAndClassify(job());
    expect(result.responseBody!.length).toBeLessThanOrEqual(2000);
  });
});

describe("attemptDelivery", () => {
  it("blocks delivery to a private-range URL without making any HTTP call", async () => {
    const result = await attemptDelivery(job({ url: "https://169.254.169.254/latest/meta-data/" }));
    expect(result.outcome).toBe("rejected");
    expect(result.errorMessage).toContain("SSRF");
  });

  it("blocks delivery to loopback — proving a real local server is never reachable through the full gated path", async () => {
    handle = await startTestHttpsServer((_req, res) => {
      res.writeHead(200);
      res.end("should never be reached");
    });
    const result = await attemptDelivery(job());
    expect(result.outcome).toBe("rejected");
    expect(result.errorMessage).toContain("SSRF");
  });

  it("delivers for real once the SSRF gate passes — proves the gate+send composition end to end", async () => {
    handle = await startTestHttpsServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    // A real webhook target is never loopback (the real guard rejects it —
    // proven above); an injected check standing in for it here is the only
    // way to exercise the FULL attemptDelivery composition (gate, then
    // send) against a server this test actually controls. Production code
    // never supplies this parameter.
    const result = await attemptDelivery(job(), async () => ({ safe: true }));
    expect(result.outcome).toBe("delivered");
  });
});
