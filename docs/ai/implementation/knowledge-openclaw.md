# Knowledge: OpenClaw Gateway & Agent System

> **Analysis purpose:** Evaluate as replacement for AgenticMinder's Agent/Tool/Storage/Core layers
> **Analysis date:** 2026-02-26
> **Depth:** Architecture-level (src/agents, src/gateway, src/memory, src/tts, src/sessions, skills, extensions)
> **Files analyzed:** Key files across ~2,973 TypeScript source files

---

## Overview

**OpenClaw** is a full-featured personal AI assistant gateway built on Node.js 22+ (ESM). It provides:

- Multi-provider LLM abstraction (Anthropic, OpenAI, Gemini, Ollama, Bedrock, Copilot, custom)
- 25+ built-in tools (shell exec, browser, web search, image analysis, TTS, memory, messaging, sub-agents)
- 51 skills (SKILL.md-defined capabilities loaded from multiple directories)
- Plugin/extension system (36 extensions for channels, auth, memory backends)
- WebSocket gateway protocol (JSON-RPC over WS, challenge-response auth)
- Multi-channel messaging (Telegram, Discord, Slack, WhatsApp, Signal, etc.)
- Persistent sessions (JSONL transcripts, session metadata store)
- Hybrid RAG memory (SQLite + vector embeddings + FTS5)
- Multi-provider TTS (Edge TTS, OpenAI, ElevenLabs)
- Sub-agent orchestration, cron scheduling, sandboxed execution

**Runtime:** Node.js 22+, TypeScript ESM, pnpm workspace
**Config:** `~/.openclaw/openclaw.json`
**Default model:** `anthropic/claude-opus-4-6`

---

## Implementation Details

### Agent System (`src/agents/`, 533 files)

The agent loop is powered by `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`:

1. **`runEmbeddedPiAgent()`** — Main entry point. Resolves model, auth, workspace, then enters attempt loop.
2. **`streamSimple()`** — Streams LLM response with tool-call handling. Subscribes to events via `subscribeEmbeddedPiSession()`.
3. **Error recovery:** Context overflow → auto-compaction + retry (3 attempts). Auth failure → profile rotation. Rate limits → failover to next profile/model.
4. **Context compaction:** Splits history into chunks, summarizes each with LLM, merges. Tool-result truncation as last resort.

**Tool assembly pipeline (`src/agents/pi-tools.ts`):**
- Base coding tools (read, write, edit, exec, grep, find, ls)
- OpenClaw tools (browser, canvas, cron, message, tts, sessions, web_search, web_fetch, image, memory)
- Plugin tools (from enabled plugins)
- **Policy pipeline:** profile → provider → agent → group → sandbox → subagent depth → owner-only

### Gateway Protocol (`src/gateway/`, 225 files)

**`chat.send` flow:**
1. Validate params → sanitize message → check `/stop` abort trigger
2. Idempotency dedup check → create AbortController
3. Immediate ACK: `{runId, status: "started"}`
4. Async dispatch → agent run → streaming events → final response

**Streaming delivery:**
- `"agent"` events: Raw token-level streaming (tool events filtered to `tool-events` capability)
- `"chat"` events: Higher-level, throttled at 150ms. States: `delta`, `final`, `error`, `aborted`
- Slow consumer protection: drop deltas or close socket

**Session management (`sessions.*`):** list, preview, resolve, patch, reset, delete, compact. Sessions persist as JSONL transcripts on disk. Token counts, model overrides, TTS preferences all stored per-session.

**Abort:** Via `chat.abort` RPC or `/stop` message. Captures partial text, persists to transcript with abort metadata.

### Storage & Memory

**Session persistence:**
- Session store: `~/.openclaw/agents/{agentId}/sessions/sessions.json` (metadata)
- Transcripts: `{sessionId}.jsonl` (full message history, rotation at 10MB)
- 500 entry cap, 30-day pruning, file locking for concurrency

**Memory system (`src/memory/`):**
- SQLite database with sqlite-vec + FTS5
- Sources: `MEMORY.md` + `memory/*.md` files + optional session transcripts
- Embedding providers: OpenAI, Gemini, Voyage, local (embeddinggemma)
- Hybrid search: 70% vector + 30% BM25, top 6 results, min score 0.35
- Auto-sync via file watcher + session delta tracking

### TTS (`src/tts/`)

Three-provider cascade:
1. **Edge TTS** (free, default) — Microsoft neural voices
2. **OpenAI TTS** — gpt-4o-mini-tts, 14 voices
3. **ElevenLabs** — Custom voices, style control

Smart pipeline: length check → directive parsing → summarization → markdown stripping → synthesis

### Skills & Plugins

**Skills:** Markdown files with YAML frontmatter. Loaded from 6 directories with ascending precedence. Eligibility filtering by OS, required bins, env vars, config. Injected into agent system prompt.

**Plugins:** Register tools, hooks (17 lifecycle events), HTTP routes, channels, gateway methods, CLI commands, services, LLM providers. Discovered from extensions/, ~/.openclaw/plugins/, workspace/plugins/.

---

## Dependencies

### Key External Libraries

| Library | Purpose |
|---------|---------|
| `@mariozechner/pi-agent-core` | Agent orchestration core |
| `@mariozechner/pi-ai` | LLM streaming, tool calling |
| `@mariozechner/pi-coding-agent` | Coding tools, session manager |
| `@sinclair/typebox` | JSON Schema generation for tool params |
| `ws` | WebSocket server |
| `express` 5 | HTTP server |
| `better-sqlite3` + `sqlite-vec` | Vector search database |
| `playwright` | Browser automation |
| `sharp` | Image processing |
| `zod` 4 | Runtime validation |

---

## Metadata

| Field | Value |
|-------|-------|
| Analysis date | 2026-02-26 |
| Source files | ~2,973 TypeScript files in src/ |
| Extensions | 36 (490 files) |
| Skills | 51 directories |
| Native apps | Android (Kotlin), iOS/macOS (Swift) |
