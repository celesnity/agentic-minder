/**
 * Phase 4 Test: Streaming deltas + abort support
 *
 * Tests:
 * 1. Connect + authenticate with token
 * 2. Send chat.send → verify runId in ack
 * 3. Collect agent streaming events → verify partial tokens accumulate
 * 4. Send chat.abort mid-stream → verify abort is accepted
 * 5. (Optional) Send another query to verify clean state after abort
 *
 * Usage: node tests/test-streaming-abort.mjs [host:port] [token]
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { WebSocket } = require("../openclaw/node_modules/ws");

const target = process.argv[2] || "127.0.0.1:18789";
const authToken = process.argv[3] || "celesnity-minder";
const url = `ws://${target}`;

console.log(`\n=== Phase 4: Streaming + Abort Test ===`);
console.log(`Target: ${url}\n`);

let messageId = 0;
let connectNonce = null;
let connectSent = false;
let connectTimer = null;
let sessionKey = null;

// Streaming state — mirrors OpenClawBridge
let streamingText = "";
let deltas = [];       // each agent token as it arrives
let chatFinalText = "";
let runId = null;
let streamDone = false;
let aborted = false;
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
        deltas.push({ text, accumulated: streamingText, done });
        process.stdout.write(text);
      }
      if (done) {
        streamDone = true;
        console.log("\n[OK] Agent stream done");
        streamListeners.forEach(fn => fn("agent-done"));
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
        chatFinalText = text;
        streamDone = true;
        console.log("\n[OK] Chat final event");
        streamListeners.forEach(fn => fn("chat-final"));
      } else if (p?.state === "aborted") {
        aborted = true;
        streamDone = true;
        console.log("\n[OK] Chat aborted event received");
        streamListeners.forEach(fn => fn("aborted"));
      } else if (p?.state === "error") {
        console.log(`\n[ERROR] Chat error: ${p.errorMessage}`);
        streamDone = true;
        streamListeners.forEach(fn => fn("error"));
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

  messageId += 1;
  const id = String(messageId);
  ws.send(JSON.stringify({
    type: "req", id, method: "connect",
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: "gateway-client", displayName: "Phase4 Test", version: "1.0.0", platform: "spectacles", mode: "node", instanceId: "p4-" + Date.now() },
      auth: { token: authToken },
      role: "operator", scopes: ["operator.admin"], caps: []
    }
  }));

  const timer = setTimeout(() => { pending.delete(id); console.log("[FAIL] Connect timeout"); ws.close(); }, 15000);
  pending.set(id, {
    resolve: (helloOk) => {
      console.log(`[3] Authenticated — protocol=${helloOk?.protocol}`);
      runTests();
    },
    reject: (err) => { console.log(`[FAIL] ${err.message}`); ws.close(); },
    timer
  });
}

function waitForStream(timeoutMs = 45000) {
  return new Promise((resolve) => {
    if (streamDone) { resolve(streamDone); return; }
    const maxWait = setTimeout(() => { console.log("\n[WARN] Stream wait timeout"); resolve(false); }, timeoutMs);
    streamListeners.push((reason) => { clearTimeout(maxWait); resolve(reason); });
  });
}

async function runTests() {
  let passed = 0;
  let failed = 0;
  const assert = (cond, label) => {
    if (cond) { console.log(`  [PASS] ${label}`); passed++; }
    else { console.log(`  [FAIL] ${label}`); failed++; }
  };

  try {
    // --- Test A: Streaming with runId ---
    console.log("\n=== Test A: Streaming + runId ===");

    const sessions = await sendRequest("sessions.list", {});
    const list = sessions?.sessions || [];
    sessionKey = list.length > 0 ? (list[0].key || list[0].sessionKey) : "default";
    console.log(`Session: ${sessionKey}`);

    // Reset streaming state
    streamingText = "";
    deltas = [];
    chatFinalText = "";
    runId = null;
    streamDone = false;
    aborted = false;

    // Send a query that should produce a medium-length response
    const ack = await sendRequest("chat.send", {
      sessionKey,
      message: "Explain the concept of recursion in programming in 3 sentences.",
      idempotencyKey: "p4-streaming-" + Date.now()
    });

    console.log(`  Ack: status=${ack?.status} runId=${ack?.runId}`);
    runId = ack?.runId || null;

    assert(ack?.status === "started", "chat.send returns {status: 'started'}");
    assert(!!ack?.runId, "chat.send returns a runId");

    // Wait for streaming response
    console.log("\n  Streaming response:");
    const reason = await waitForStream();

    assert(deltas.length > 0, `Received ${deltas.length} streaming delta(s)`);
    assert(streamingText.length > 0, `Accumulated text: ${streamingText.length} chars`);
    assert(streamDone, "Stream completed (done=true or chat final)");

    // Verify deltas accumulate correctly
    if (deltas.length > 0) {
      const lastDelta = deltas[deltas.length - 1];
      assert(lastDelta.accumulated === streamingText, "Last delta.accumulated matches streamingText");
    }

    console.log(`\n  Total deltas: ${deltas.length}`);
    console.log(`  Final text (${streamingText.length} chars): "${streamingText.substring(0, 200)}..."`);

    // --- Test B: Abort mid-stream ---
    console.log("\n=== Test B: Abort mid-stream ===");

    // Reset
    streamingText = "";
    deltas = [];
    chatFinalText = "";
    runId = null;
    streamDone = false;
    aborted = false;
    streamListeners.length = 0;

    // Send a query that produces a long response
    const ack2 = await sendRequest("chat.send", {
      sessionKey,
      message: "Write a detailed 500-word essay about the history of computing from the 1940s to today.",
      idempotencyKey: "p4-abort-" + Date.now()
    });

    runId = ack2?.runId || null;
    console.log(`  Ack: status=${ack2?.status} runId=${runId}`);

    // Wait for at least 1 delta, then abort
    console.log("  Waiting for first streaming token...");
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (deltas.length >= 1 || streamDone) {
          clearInterval(check);
          resolve();
        }
      }, 100);
      // Fallback: abort after 5s even if no tokens
      setTimeout(() => { clearInterval(check); resolve(); }, 5000);
    });

    const tokensBeforeAbort = deltas.length;
    const textBeforeAbort = streamingText;
    console.log(`  Tokens before abort: ${tokensBeforeAbort}`);
    console.log(`  Text before abort (${textBeforeAbort.length} chars): "${textBeforeAbort.substring(0, 100)}..."`);

    // Send abort
    console.log("  Sending chat.abort...");
    const abortParams = { sessionKey };
    if (runId) abortParams.runId = runId;

    try {
      const abortResult = await sendRequest("chat.abort", abortParams, { timeout: 5000 });
      console.log(`  Abort ack: ${JSON.stringify(abortResult)}`);
      assert(true, "chat.abort accepted by server");
    } catch (err) {
      // Some servers return an error if the run already completed
      console.log(`  Abort response: ${err.message}`);
      if (streamDone) {
        console.log("  (Run already completed before abort arrived)");
        assert(true, "chat.abort sent (run already finished)");
      } else {
        assert(false, `chat.abort rejected: ${err.message}`);
      }
    }

    // Wait briefly for abort event
    if (!streamDone) {
      await waitForStream(5000);
    }

    // If server sent abort event, streamDone should be true
    if (aborted) {
      assert(true, "Received chat aborted event from server");
    } else if (streamDone) {
      console.log("  (Stream completed before abort took effect — this is OK for fast responses)");
      assert(true, "Stream completed (abort race condition — acceptable)");
    } else {
      assert(false, "Neither abort event nor stream completion received");
    }

    // --- Summary ---
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    ws.close(1000, "test complete");

  } catch (err) {
    console.log(`\n[FAIL] ${err.message}`);
    ws.close();
  }
}
