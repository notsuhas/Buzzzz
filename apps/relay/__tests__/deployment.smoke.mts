import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { isRecord } from "@buzzzz/core";

const origin = process.env.VITE_RELAY_URL;
assert.ok(origin && new URL(origin).origin === origin, "Set VITE_RELAY_URL to the Studio origin");
const request = (path: string, init: RequestInit = {}) =>
  fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(15_000), redirect: "error" });

async function json(response: Response, status = 200) {
  assert.equal(response.status, status);
  const value: unknown = await response.json();
  assert.ok(isRecord(value), "Expected a JSON object");
  return value;
}

function connect(url: unknown, role: "host" | "phone"): Promise<WebSocket> {
  assert.ok(typeof url === "string", "Missing relay URL");
  assert.equal(new URL(url).origin.replace(/^ws/, "http"), origin);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: role === "host" ? { Origin: origin } : {} });
    const fail = () => {
      clearTimeout(timeout);
      socket.terminate();
      reject(new Error(`${role} WebSocket did not establish a session`));
    };
    const timeout = setTimeout(fail, 15_000);
    socket.once("error", fail);
    socket.once("close", fail);
    socket.on("message", function session(raw) {
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!isRecord(message) || message.type !== "session" || message.role !== role) return;
      clearTimeout(timeout);
      socket.removeListener("message", session);
      socket.removeListener("close", fail);
      resolve(socket);
    });
  });
}

assert.equal((await json(await request("/health"))).ok, true);
const page = await request("/");
assert.equal(page.status, 200);
const html = await page.text();
assert.ok(html.includes("Buzzzz · Haptics studio"), "Studio HTML was not served");
const script = html.match(/<script[^>]*src="([^"]+)"/u)?.[1];
assert.ok(
  typeof script === "string" && script.startsWith("/assets/"),
  "Missing production JavaScript entry",
);
assert.match((await request(script)).headers.get("Content-Type") ?? "", /javascript/u);
assert.match((await request("/favicon.svg")).headers.get("Content-Type") ?? "", /image\/svg/u);
assert.equal(
  (await request("/deployment-check", { headers: { "Sec-Fetch-Mode": "navigate" } })).status,
  200,
);
await json(await request("/v1/not-a-route", { headers: { "Sec-Fetch-Mode": "navigate" } }), 404);
assert.equal(
  (await request("/v1/rooms", { method: "POST", headers: { Origin: "https://untrusted.invalid" } }))
    .status,
  403,
);

const room = await json(
  await request("/v1/rooms", { method: "POST", headers: { Origin: origin } }),
  201,
);
assert.ok(
  typeof room.roomId === "string" && /^[a-f0-9]{32}$/u.test(room.roomId),
  "Invalid room ID",
);
assert.ok(typeof room.hostToken === "string", "Missing host token");
const path = `/v1/rooms/${room.roomId}`;
const headers = { Authorization: `Bearer ${room.hostToken}`, Origin: origin };
const sockets: WebSocket[] = [];
let failure: unknown;
try {
  const project = await json(await request(`${path}/project`, { headers }));
  assert.equal(project.project, null);
  assert.equal(project.revision, 0);
  sockets.push(await connect(room.relayUrl, "host"));
  assert.ok(isRecord(room.pairing), "Missing pairing code");
  const phone = await json(
    await request(`${path}/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: room.pairing.code, device: "Deployment smoke check" }),
    }),
    201,
  );
  sockets.push(await connect(phone.relayUrl, "phone"));
  const body = JSON.stringify({ deploymentCheck: true });
  const asset = await json(
    await request(`${path}/assets?kind=media`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
    }),
    201,
  );
  assert.ok(
    typeof asset.url === "string" && new URL(asset.url).origin === origin,
    "Invalid asset URL",
  );
  const read = await request(asset.url);
  assert.equal(read.status, 200);
  assert.equal(await read.text(), body);
  const unsigned = new URL(asset.url);
  unsigned.search = "";
  assert.equal((await request(unsigned.href)).status, 404);
} catch (error) {
  failure = error;
}
for (const socket of sockets) socket.terminate();
try {
  assert.equal((await json(await request(path, { method: "DELETE", headers }))).revoked, true);
} catch (error) {
  if (failure)
    throw new AggregateError([failure, error], "Deployment check and room cleanup failed");
  throw error;
}
if (failure) throw failure;
assert.equal((await request(`${path}/project`, { headers })).status, 410);
console.log(
  "Deployment verified: Studio, assets, origin isolation, pairing, WebSockets, private R2, and room cleanup.",
);
