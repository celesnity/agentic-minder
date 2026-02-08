# 🆓 Local Embeddings Setup - Complete Guide

## ✅ What Was Changed

### 1. **Removed OpenAI Dependency**
- ❌ No more OpenAI API key needed
- ❌ No more quota errors
- ✅ 100% FREE local embeddings

### 2. **Added Sentence Transformers**
- Model: `all-mpnet-base-v2`
- Vector size: 768 dimensions (was 1536)
- Quality: Very good
- Speed: Fast on MacBook

### 3. **Added Extensive Logging**
Every step now shows detailed logs:
- 🔌 WebSocket connections
- 📥 Ingest operations
- 🔄 Embedding generation
- 💾 Qdrant storage
- ✅ Success confirmations

---

## 🚀 Installation & Startup

### Quick Start (Automated)
```bash
cd /Users/ledinhnguyen/Git/hub/agentic-minder
./setup_local_embeddings.sh
```

This script will:
1. ✅ Install sentence-transformers
2. ✅ Download the model (~400MB, one-time)
3. ✅ Reset Qdrant collection
4. ✅ Start server with detailed logs
5. ✅ Show your network IP

### Manual Steps (if needed)
```bash
cd server/vector_memory
source .venv/bin/activate
pip install -r requirements.txt

# Reset collection for new vector size
curl -X DELETE http://localhost:6333/collections/latest_session

# Start server
uvicorn main:app --reload --host 0.0.0.0 --port 8787
```

---

## 📊 Expected Logs

When the server starts, you'll see:

```
🔄 Loading Sentence Transformers model: all-mpnet-base-v2
✅ Model loaded successfully! Vector size: 768
🚀 FastAPI server initialized
📊 Configuration:
   - Qdrant URL: http://127.0.0.1:6333
   - Collection: latest_session
   - Embedding Model: all-mpnet-base-v2 (LOCAL - FREE)
   - Vector Dimensions: 768
INFO:     Started server process
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8787
```

### When Spectacles Connects:
```
🔌 WebSocket: New connection from ('192.168.40.51', 54836)
✅ WebSocket: Connection accepted
🔍 Checking if collection 'latest_session' exists...
✅ Collection 'latest_session' already exists
🎧 WebSocket: Listening for messages...
```

### When Recording Starts:
```
📨 WebSocket: Received message
   - Request ID: req_123
   - Operation: reset
🔄 WebSocket: Processing RESET operation
🔄 Resetting collection 'latest_session'...
🗑️ Deleting existing collection 'latest_session'
📦 Creating fresh collection 'latest_session' with vector size 768
✅ Collection 'latest_session' reset successfully!
✅ WebSocket: RESET completed, response sent
```

### When Transcript is Ingested:
```
📨 WebSocket: Received message
   - Request ID: req_124
   - Operation: ingest
📥 WebSocket: Processing INGEST operation
   - Chunk ID: chunk_1770542345678
   - Text length: 320 chars
   - Text preview: 'Hello, this is a test of the transcript system...'
📥 HTTP: Ingest request received
   - Chunk ID: chunk_1770542345678
   - Text length: 320 chars
   - Text preview: 'Hello, this is a test of the transcript system...'
🔍 Checking if collection 'latest_session' exists...
✅ Collection 'latest_session' already exists
🔄 Generating embedding for text (320 chars): 'Hello, this is a test of the transcript system...'
✅ Embedding generated successfully! Vector size: 768
💾 Storing vector in Qdrant...
✅ Vector stored successfully in Qdrant!
📊 Collection 'latest_session' now contains this chunk
✅ WebSocket: INGEST completed, response sent
```

---

## 🧪 Testing

### 1. Start the Server
```bash
./setup_local_embeddings.sh
```

Wait for: `✅ Model loaded successfully!`

### 2. Test in Lens Studio
- Open Lens Studio
- Run Preview mode
- Press microphone button
- Start speaking

### 3. Watch Server Logs
You should see:
1. **Connection**: `🔌 WebSocket: New connection`
2. **Reset**: `🔄 WebSocket: Processing RESET operation`
3. **Ingest**: `📥 WebSocket: Processing INGEST operation` (repeats for each chunk)
4. **Embeddings**: `🔄 Generating embedding for text`
5. **Storage**: `✅ Vector stored successfully in Qdrant!`

### 4. Verify in Qdrant Dashboard
```
http://localhost:6333/dashboard
```

- Collection: `latest_session`
- Vectors: Should show increasing count
- Vector size: 768 dimensions

---

## 🐛 Troubleshooting

### "Model download failed"
```bash
# Manually download
cd server/vector_memory
source .venv/bin/activate
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-mpnet-base-v2')"
```

### "Wrong vector size" error
```bash
# Reset Qdrant collection
curl -X DELETE http://localhost:6333/collections/latest_session
# Restart server
./setup_local_embeddings.sh
```

### "No embeddings in logs"
- Check Lens Studio is connected
- Verify recording is started
- Look for `📥 WebSocket: Processing INGEST` in server logs

### "Server won't start"
```bash
# Check port 8787 is free
lsof -ti:8787 | xargs kill

# Restart
./setup_local_embeddings.sh
```

---

## 📈 Performance Comparison

| Feature | OpenAI | Sentence Transformers (all-mpnet-base-v2) |
|---------|--------|-------------------------------------------|
| **Cost** | $$$ | **FREE** ✅ |
| **Quality** | Excellent (9/10) | Very Good (8/10) ✅ |
| **Speed** | ~500ms (network) | ~100ms (local) ✅ |
| **Vector Size** | 1536 | 768 |
| **Rate Limits** | Yes | **None** ✅ |
| **Offline** | No | **Yes** ✅ |
| **Privacy** | Data sent to OpenAI | **All local** ✅ |

---

## ✅ Success Criteria

Your setup is working when you see:

1. ✅ Server starts: `✅ Model loaded successfully! Vector size: 768`
2. ✅ Connection: `🔌 WebSocket: New connection`
3. ✅ Reset: `✅ Collection 'latest_session' reset successfully!`
4. ✅ Ingest: `📥 WebSocket: Processing INGEST operation`
5. ✅ Embeddings: `✅ Embedding generated successfully! Vector size: 768`
6. ✅ Storage: `✅ Vector stored successfully in Qdrant!`
7. ✅ Qdrant dashboard shows vectors increasing

---

## 🎯 What to Watch in Logs

### Key Log Messages

**Model Loading** (startup):
```
🔄 Loading Sentence Transformers model: all-mpnet-base-v2
✅ Model loaded successfully! Vector size: 768
```

**WebSocket Activity**:
```
🔌 WebSocket: New connection
📨 WebSocket: Received message
✅ WebSocket: [OPERATION] completed
```

**Embedding Generation**:
```
🔄 Generating embedding for text (XXX chars): 'text preview...'
✅ Embedding generated successfully! Vector size: 768
```

**Qdrant Operations**:
```
💾 Storing vector in Qdrant...
✅ Vector stored successfully in Qdrant!
```

---

## 🔥 Benefits

1. ✅ **Completely Free** - No API costs ever
2. ✅ **No Rate Limits** - Process as much as you want
3. ✅ **Faster** - Local processing beats network calls
4. ✅ **Private** - All data stays on your machine
5. ✅ **Detailed Logs** - See every step of the process
6. ✅ **Offline** - Works without internet
7. ✅ **MacBook Optimized** - Runs great on M1/M2/M3

---

## 🚀 Ready to Test!

Run this command to start:
```bash
cd /Users/ledinhnguyen/Git/hub/agentic-minder
./setup_local_embeddings.sh
```

Then watch the beautiful logs! 🎉
