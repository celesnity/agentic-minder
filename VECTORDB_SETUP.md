# VectorDB Setup for Spectacles

## Quick Start

### 1. Start Qdrant (if not running)
```bash
cd server/vector_memory
docker compose up -d
```

### 2. Start the Vector Server (Network Mode)
```bash
cd server/vector_memory
source .venv/bin/activate
export OPENAI_API_KEY="your-key-here"

# IMPORTANT: Use 0.0.0.0 to allow Spectacles to connect
uvicorn main:app --reload --host 0.0.0.0 --port 8787
```

### 3. Find Your Network IP
```bash
ifconfig | grep "inet " | grep -v 127.0.0.1
```

**Example output:** `inet 192.168.40.51`

### 4. Configure Lens Studio

The Scene has been updated with:
- **VectorIngestController** component added to SummaryStorage object
- **useRemoteVectorService**: `true`
- **remoteWsUrl**: `ws://192.168.40.51:8787/ws` (update with YOUR IP)

**To customize:**
1. Open Lens Studio
2. Select the **SummaryStorage** scene object
3. Find **VectorIngestController** component
4. Update **remoteWsUrl** with your actual IP from step 3
5. Ensure **useRemoteVectorService** is checked

### 5. How It Works

When `useRemoteVectorService: true`:
- ✅ Audio transcripts are chunked and sent to VectorDB (Qdrant)
- ✅ Semantic search is available via VectorDB
- ❌ Persistent Storage writes are **disabled** (VectorDB-only mode)
- ❌ No `.txt` exports in Lens Studio preview panel

When `useRemoteVectorService: false`:
- ✅ Uses on-device Persistent Storage
- ✅ Exports visible in Lens Studio preview panel
- ❌ No VectorDB integration

## Network Requirements

### For Lens Studio Preview
- Can use `127.0.0.1` or `0.0.0.0`
- Works with localhost

### For Spectacles Device
- **MUST** use network-accessible IP (e.g., `192.168.40.51`)
- **CANNOT** use `localhost` or `127.0.0.1`
- Device must be on same WiFi network as development machine
- Server must bind to `0.0.0.0` (all interfaces)

## Troubleshooting

### "VectorIngestController not in logs"
- Check that component is in Scene hierarchy
- Verify `enableIngestion: true`
- Check `summaryASRController` and `summaryStorage` are wired

### "WebSocket connection failed"
- Verify server is running: `curl http://YOUR_IP:8787/health`
- Check firewall allows port 8787
- Confirm Spectacles and computer on same network
- Try IP from: `ifconfig | grep "inet " | grep -v 127.0.0.1`

### "Storage shows as empty"
- This is **expected** in VectorDB mode
- Data is stored in Qdrant, not Persistent Storage
- Check Qdrant dashboard: `http://localhost:6333/dashboard`

## Verification

Test server health:
```bash
curl http://192.168.40.51:8787/health
```

Expected response:
```json
{
  "ok": true,
  "qdrant_url": "http://127.0.0.1:6333",
  "collection": "latest_session",
  "embed_model": "text-embedding-3-small"
}
```
