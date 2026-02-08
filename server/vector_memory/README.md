# Local Vector Memory (FastAPI + Qdrant)

Internal demo helper for Lens Studio Preview.

## What it does
- Runs a local WebSocket + HTTP service on `127.0.0.1:8787`
- Stores transcript chunks in Qdrant (`127.0.0.1:6333`)
- Computes embeddings server-side with OpenAI Embeddings API
- Supports:
  - reset latest session
  - ingest chunk
  - semantic search (top‑K)

## Prereqs
- Docker (for Qdrant)
- Python 3.10+
- An OpenAI API key exported as `OPENAI_API_KEY`

## Start Qdrant
From `server/vector_memory`:
```bash
docker compose up -d
```

Verify:
```bash
curl http://127.0.0.1:6333/healthz
```

## Start the server
From `server/vector_memory`:
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export OPENAI_API_KEY="YOUR_KEY"

# For local development (Lens Studio Preview only):
uvicorn main:app --reload --host 127.0.0.1 --port 8787

# For Spectacles (network-accessible mode):
uvicorn main:app --reload --host 0.0.0.0 --port 8787
# Then find your IP: ifconfig | grep "inet " | grep -v 127.0.0.1
# Use ws://YOUR_LOCAL_IP:8787/ws in Lens Studio
```

Health check:
```bash
curl http://127.0.0.1:8787/health
```

## Lens Studio wiring (remote mode)
In the scene:
- Add `InternetModule` asset and assign it to:
  - `VectorIngestController.internetModule`
  - `AgentOrchestrator.internetModule`
- For vectorDB-only (no Persistent Storage transcript saving), set:
  - `SummaryStorage.enablePersistentStorage = false`
  - `SummaryStorage.enableStorageExports = false`
- Set:
  - `VectorIngestController.useRemoteVectorService = true`
  - `VectorIngestController.remoteWsUrl = ws://127.0.0.1:8787/ws`
  - `AgentOrchestrator.vectorMemoryMode = remote`
  - `AgentOrchestrator.remoteVectorWsUrl = ws://127.0.0.1:8787/ws`

Then demo:
1) Press the Summary mic (start) → server resets latest session.
2) Talk while “watching” → transcript chunks ingest.
3) Stop Summary mic → flush leftover.
4) Use Chat mic to ask follow-ups → semantic search injects context into the chatbot.
