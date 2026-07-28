import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

// packages/* build as CommonJS (unlike apps/*, which are "type": "module"),
// so the CJS-native __dirname is used here rather than import.meta.url —
// the latter is a TS error under this package's module setting.
const CERT_PATH = join(__dirname, "fixtures", "test-cert.pem");
const KEY_PATH = join(__dirname, "fixtures", "test-key.pem");

/** Throwaway 10-year self-signed cert for localhost — test-only, generated
 *  once via openssl, not a real secret (same "label it, don't treat it
 *  like a real credential" convention as the docker-compose dev passwords). */
export function testTlsOptions() {
  return { cert: readFileSync(CERT_PATH), key: readFileSync(KEY_PATH) };
}

/** SSRF-guarded delivery requires https — trusting the self-signed test
 *  cert globally (scoped to the test file's lifetime, restored after) is
 *  what lets Node's real `fetch()` (used by attemptDelivery, unmodified)
 *  actually reach a local test server instead of every call needing its
 *  own bespoke TLS config. Same undici Agent/setGlobalDispatcher pattern
 *  this codebase already uses for MockAgent elsewhere. */
export function trustTestCert(): () => void {
  const original = getGlobalDispatcher();
  setGlobalDispatcher(new Agent({ connect: { ca: readFileSync(CERT_PATH) } }));
  return () => setGlobalDispatcher(original);
}

export interface TestHttpsServerHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export async function startTestHttpsServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<TestHttpsServerHandle> {
  const server = createServer(testTlsOptions(), handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    url: `https://localhost:${port}/webhook`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function readRequestBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
  });
}
