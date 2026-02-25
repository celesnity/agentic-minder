/**
 * Full E2E Test: Device pairing + sessions.list + chat.send + streaming
 *
 * 1. Generate ED25519 device identity
 * 2. Connect with device signing + gateway token
 * 3. Get auto-approved, receive device token + scopes
 * 4. List sessions
 * 5. Send chat.send query
 * 6. Collect streaming agent events
 *
 * Usage: node tests/test-full-e2e.mjs [host:port] [gateway-token]
 */

import crypto from "node:crypto";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { WebSocket } = require("../openclaw/node_modules/ws");

const target = process.argv[2] || "127.0.0.1:18789";
const gatewayToken = process.argv[3] || "celesnity-minder";
const url = `ws://${target}`;

console.log(`\n=== Full E2E Test ===`);
console.log(`Target: ${url}\n`);

// --- Device identity ---
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
const rawKeyBytes = publicKeyDer.subarray(-32);
const deviceId = crypto.createHash("sha256").update(rawKeyBytes).digest("hex");
const base64UrlEncode = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const publicKeyBase64Url = base64UrlEncode(rawKeyBytes);
const signPayload = (p) => base64UrlEncode(crypto.sign(null, Buffer.from(p, "utf8"), privateKey));

function buildAuthPayload(params) {
  const v = params.nonce ? "v2" : "v1";
  const base = [v, params.deviceId, params.clientId, params.clientMode, params.role, params.scopes.join(","), String(params.signedAtMs), params.token || ""];
  if (v === "v2") base.push(params.nonce || "");
  return base.join("|");
}

// --- Connection state ---
let messageId = 0;
let connectNonce = null;
let connectSent = false;
let connectTimer = null;
let streamingText = "";
let streamDone = false;
const pending = new Map();
const streamListeners = [];

const ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });
const testTimeout = setTimeout(() => { console.log("\n[TIMEOUT]"); ws.close(); process.exit(1); }, 90000);

function sendRequest(method, params, opts = {}) {
  messageId += 1;
  const id = String(messageId);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, opts.timeout || 30000);
    pending.set(id, { resolve, reject, timer });
  });
}

ws.on("open", () => {
  console.log("[1] WebSocket connected");
  connectTimer = setTimeout(() => sendConnect(), 750);
});

ws.on("message", (raw) => {
  let parsed;
  try { parsed = JSON.parse(raw.toString()); } catch { return; }

  if (parsed.type === "event") {
    if (parsed.event === "connect.challenge") {
      connectNonce = parsed.payload?.nonce;
      console.log("[2] Challenge received");
      sendConnect();
      return;
    }
    if (parsed.event === "agent") {
      const p = parsed.payload;
      const text = p?.text || p?.content || "";
      const done = !!p?.done;
      if (text) {
        streamingText += text;
        process.stdout.write(text);
      }
      if (done) {
        streamDone = true;
        console.log("\n[OK] Agent stream complete");
        streamListeners.forEach(fn => fn());
      }
      return;
    }
    if (parsed.event === "chat") {
      const p = parsed.payload;
      if (p?.state === "final" && p?.message) {
        const content = p.message.content;
        let text = "";
        if (Array.isArray(content)) {
          text = content.filter(c => c.type === "text").map(c => c.text).join("\n");
        } else if (typeof content === "string") {
          text = content;
        }
        if (text) {
          streamingText += text;
          process.stdout.write(text);
        }
        streamDone = true;
        console.log("\n[OK] Chat final event received");
        streamListeners.forEach(fn => fn());
      } else if (p?.state === "error") {
        console.log(`\n[ERROR] Chat error: ${p.errorMessage}`);
        streamDone = true;
        streamListeners.forEach(fn => fn());
      }
      return;
    }
    if (parsed.event === "tick" || parsed.event === "health") return;
    return;
  }

  if (parsed.type === "res") {
    const entry = pending.get(parsed.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(parsed.id);
    parsed.ok ? entry.resolve(parsed.payload) : entry.reject(new Error(parsed.error?.message || "error"));
  }
});

ws.on("close", (code) => { clearTimeout(testTimeout); console.log(`\nClosed: code=${code}`); process.exit(code === 1000 ? 0 : 1); });
ws.on("error", (err) => { clearTimeout(testTimeout); console.log(`[FAIL] ${err.message}`); process.exit(1); });

function sendConnect() {
  if (connectSent) return;
  connectSent = true;
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }

  const role = "operator";
  const scopes = ["operator.admin"];
  const signedAtMs = Date.now();
  const nonce = connectNonce || undefined;
  const payload = buildAuthPayload({ deviceId, clientId: "gateway-client", clientMode: "node", role, scopes, signedAtMs, token: gatewayToken, nonce });
  const signature = signPayload(payload);

  messageId += 1;
  const id = String(messageId);
  ws.send(JSON.stringify({
    type: "req", id, method: "connect",
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: "gateway-client", displayName: "Spectacles E2E Test", version: "1.0.0", platform: "spectacles", mode: "node", instanceId: "e2e-" + Date.now() },
      auth: { token: gatewayToken },
      role, scopes, caps: [],
      device: { id: deviceId, publicKey: publicKeyBase64Url, signature, signedAt: signedAtMs, nonce }
    }
  }));

  const timer = setTimeout(() => { pending.delete(id); console.log("[FAIL] Connect timeout"); ws.close(); }, 15000);
  pending.set(id, {
    resolve: (helloOk) => {
      console.log(`[3] Authenticated — role=${helloOk?.auth?.role} scopes=[${helloOk?.auth?.scopes?.join(",")}] token=${helloOk?.auth?.deviceToken ? "YES" : "NO"}`);
      runTest();
    },
    reject: (err) => { console.log(`[FAIL] ${err.message}`); ws.close(); },
    timer
  });
}

async function runTest() {
  try {
    // List sessions
    console.log("\n--- sessions.list ---");
    const sessions = await sendRequest("sessions.list", {});
    const list = sessions?.sessions || [];
    console.log(`[4] Found ${list.length} session(s)`);

    let sessionKey;
    if (list.length > 0) {
      sessionKey = list[0].key || list[0].sessionKey;
      console.log(`    Using: ${sessionKey}`);
    } else {
      sessionKey = "default";
      console.log("    No sessions, using 'default'");
    }

    // Send chat query
    console.log("\n--- chat.send: 'Hello, what is 2+2?' ---");
    streamingText = "";
    streamDone = false;

    const chatResult = await sendRequest("chat.send", {
      sessionKey,
      message: "Hello, what is 2+2?",
      idempotencyKey: "e2e-" + Date.now()
    });
    console.log(`[5] chat.send: status=${chatResult?.status} runId=${chatResult?.runId}`);

    // Wait for streaming to complete
    if (!streamDone) {
      console.log("\n--- Agent streaming ---");
      await new Promise((resolve) => {
        if (streamDone) { resolve(); return; }
        const maxWait = setTimeout(() => { console.log("\n[WARN] Stream timeout"); resolve(); }, 45000);
        streamListeners.push(() => { clearTimeout(maxWait); resolve(); });
      });
    }

    console.log("\n--- Result ---");
    if (streamingText) {
      console.log(`Response (${streamingText.length} chars): ${streamingText.substring(0, 500)}`);
      console.log("\n[PASS] Full E2E test successful!");
    } else {
      console.log("[WARN] No streaming text received.");
    }

    ws.close(1000, "test complete");
  } catch (err) {
    console.log(`\n[FAIL] ${err.message}`);
    ws.close();
  }
}
