/**
 * Test script: Create device identity, connect, get auto-approved, extract device token.
 *
 * This generates an ED25519 keypair, performs the full device pairing flow,
 * and prints the resulting device token. The token can then be used by Spectacles
 * for token-only auth with proper scopes.
 *
 * Usage: node tests/test-device-pair.mjs [host:port] [gateway-auth-token]
 */

import crypto from "node:crypto";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { WebSocket } = require("../openclaw/node_modules/ws");

const target = process.argv[2] || "127.0.0.1:18789";
const gatewayToken = process.argv[3] || "celesnity-minder";
const url = `ws://${target}`;

console.log(`\n=== Device Pairing Test ===`);
console.log(`Target: ${url}\n`);

// --- Generate ED25519 device identity ---
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

// Derive device ID: SHA-256 of raw public key bytes
const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
const rawKeyBytes = publicKeyDer.subarray(-32); // Last 32 bytes = raw ED25519 public key
const deviceId = crypto.createHash("sha256").update(rawKeyBytes).digest("hex");

// Base64URL encode the raw public key
function base64UrlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const publicKeyBase64Url = base64UrlEncode(rawKeyBytes);

console.log(`Device ID: ${deviceId}`);
console.log(`Public key: ${publicKeyBase64Url.substring(0, 20)}...`);

// --- Signing ---
function signPayload(payload) {
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), privateKey);
  return base64UrlEncode(sig);
}

function buildPayload(params) {
  const { deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce, version } = params;
  const v = version || (nonce ? "v2" : "v1");
  const base = [v, deviceId, clientId, clientMode, role, scopes.join(","), String(signedAtMs), token || ""];
  if (v === "v2") base.push(nonce || "");
  return base.join("|");
}

// --- WebSocket connection ---
let messageId = 0;
let connectNonce = null;
let connectSent = false;
let connectTimer = null;
const pending = new Map();

const ws = new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });

const testTimeout = setTimeout(() => {
  console.log("\n[FAIL] Timed out");
  ws.close();
  process.exit(1);
}, 30000);

function sendRequest(method, params, opts = {}) {
  messageId += 1;
  const id = String(messageId);
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, opts.timeout || 15000);
    pending.set(id, { resolve, reject, timer });
  });
}

ws.on("open", () => {
  console.log("[OK] Connected");
  connectTimer = setTimeout(() => sendConnect(), 750);
});

ws.on("message", (raw) => {
  const data = raw.toString();
  let parsed;
  try { parsed = JSON.parse(data); } catch { return; }

  if (parsed.type === "event") {
    if (parsed.event === "connect.challenge") {
      connectNonce = parsed.payload?.nonce;
      console.log(`[OK] Challenge: nonce=${connectNonce?.substring(0, 8)}...`);
      sendConnect();
      return;
    }
    if (parsed.event === "device.pair.requested") {
      console.log(`[INFO] Pairing requested: ${JSON.stringify(parsed.payload)?.substring(0, 200)}`);
      return;
    }
    if (parsed.event === "device.pair.resolved") {
      console.log(`[INFO] Pairing resolved: ${JSON.stringify(parsed.payload)}`);
      return;
    }
    if (parsed.event === "tick" || parsed.event === "health") return;
    console.log(`[EVENT] ${parsed.event}`);
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

ws.on("close", (code) => {
  clearTimeout(testTimeout);
  console.log(`\nClosed: code=${code}`);
  process.exit(code === 1000 ? 0 : 1);
});

ws.on("error", (err) => {
  clearTimeout(testTimeout);
  console.log(`[FAIL] ${err.message}`);
  process.exit(1);
});

function sendConnect() {
  if (connectSent) return;
  connectSent = true;
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }

  const role = "operator";
  const scopes = ["operator.admin"];
  const signedAtMs = Date.now();
  const nonce = connectNonce || undefined;

  const payload = buildPayload({
    deviceId, clientId: "gateway-client", clientMode: "node",
    role, scopes, signedAtMs, token: gatewayToken, nonce
  });
  const signature = signPayload(payload);

  messageId += 1;
  const id = String(messageId);
  const frame = {
    type: "req", id, method: "connect",
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: {
        id: "gateway-client",
        displayName: "Spectacles Device (Pairing)",
        version: "1.0.0",
        platform: "spectacles",
        mode: "node",
        instanceId: "pair-" + Date.now()
      },
      auth: { token: gatewayToken },
      role, scopes, caps: [],
      device: {
        id: deviceId,
        publicKey: publicKeyBase64Url,
        signature,
        signedAt: signedAtMs,
        nonce
      }
    }
  };

  console.log("[OK] Sending ConnectParams with device identity...");
  ws.send(JSON.stringify(frame));

  const timer = setTimeout(() => { pending.delete(id); console.log("[FAIL] Connect timeout"); ws.close(); }, 15000);
  pending.set(id, {
    resolve: async (helloOk) => {
      console.log(`[OK] HelloOk received!`);
      console.log(`  connId: ${helloOk?.server?.connId}`);
      console.log(`  auth.deviceToken: ${helloOk?.auth?.deviceToken || "NONE"}`);
      console.log(`  auth.role: ${helloOk?.auth?.role || "none"}`);
      console.log(`  auth.scopes: [${helloOk?.auth?.scopes?.join(", ") || ""}]`);

      if (helloOk?.auth?.deviceToken) {
        console.log(`\n========================================`);
        console.log(`DEVICE TOKEN (use this in Spectacles):`);
        console.log(`${helloOk.auth.deviceToken}`);
        console.log(`========================================\n`);

        // Test: list sessions with this connection
        try {
          const sessions = await sendRequest("sessions.list", {});
          console.log(`[OK] sessions.list works! Found ${sessions?.sessions?.length || 0} sessions`);

          if (sessions?.sessions?.length > 0) {
            const key = sessions.sessions[0].key || sessions.sessions[0].sessionKey;
            console.log(`[OK] First session: ${key?.substring(0, 20)}...`);
          }
        } catch (err) {
          console.log(`[WARN] sessions.list: ${err.message}`);
        }
      }

      ws.close(1000, "done");
    },
    reject: (err) => {
      console.log(`[FAIL] Connect: ${err.message}`);
      ws.close();
    },
    timer
  });
}
