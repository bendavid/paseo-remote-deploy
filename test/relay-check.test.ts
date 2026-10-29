import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { checkEndpoint, relayUrl } from "../server/deploy";

let server: Server;
let port: number;

beforeAll(async () => {
  // A relay answers plain requests with an error before the WebSocket upgrade; that still counts.
  server = createServer((_request, response) => response.writeHead(426).end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("relayUrl follows the TLS setting", () => {
  expect(relayUrl("relay.example.com:443", true)).toBe("https://relay.example.com:443/");
  expect(relayUrl("10.0.0.5:4000", false)).toBe("http://10.0.0.5:4000/");
});

test("checkEndpoint connects, and names the failure otherwise", async () => {
  expect(await checkEndpoint(`127.0.0.1:${port}`, false)).toBeNull();
  // Ports fetch() refuses are fine for a relay, as they are for the daemon's WebSocket client.
  expect(await checkEndpoint("127.0.0.1:9", false)).toBe("ECONNREFUSED");
  // TLS against a plain HTTP server fails the handshake, as the daemon's relay client would.
  expect(await checkEndpoint(`127.0.0.1:${port}`, true)).not.toBeNull();
  expect(await checkEndpoint(`[::1]:${port}`, false)).not.toBe("ENOTFOUND");
});
