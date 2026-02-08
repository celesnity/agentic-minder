# 📋 VectorDB CRUD - Quick Reference

## 🚀 Quick Start

```bash
# Start server
./setup_local_embeddings.sh

# Test CRUD operations
cd server/vector_memory
python test_crud_operations.py
```

---

## 📡 **Operations Summary**

| Operation | HTTP Endpoint | WebSocket Op | TypeScript Method |
|-----------|---------------|--------------|-------------------|
| **CREATE** | `POST /ingest` | `ingest` | `ingestChunk(text, id, time)` |
| **READ (search)** | `POST /search` | `search` | `search(query, topK)` |
| **READ (list)** | `GET /list` | `list` | `listChunks(limit, offset)` |
| **DELETE** | `POST /delete` | `delete` | `deleteChunks(ids[])` |
| **COUNT** | `GET /count` | `count` | `getChunkCount()` |
| **RESET** | `POST /reset` | `reset` | `resetLatestSession()` |

---

## 💻 **TypeScript Examples**

### Check Status
```typescript
const count = await remoteClient.getChunkCount()
console.log(`VectorDB has ${count} chunks`)
```

### View All Data
```typescript
const {chunks, total_count} = await remoteClient.listChunks(100, 0)
chunks.forEach(c => console.log(`${c.chunk_id}: ${c.text_preview}`))
```

### Semantic Search
```typescript
const results = await remoteClient.search("machine learning", 5)
results.forEach(r => console.log(`${r.score}: ${r.text}`))
```

### Delete Chunks
```typescript
const deleted = await remoteClient.deleteChunks(["chunk_1", "chunk_2"])
console.log(`Deleted ${deleted} chunks`)
```

---

## 🔧 **HTTP Examples**

### Count
```bash
curl http://localhost:8787/count
```

### List
```bash
curl "http://localhost:8787/list?limit=10&offset=0"
```

### Search
```bash
curl -X POST http://localhost:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "AI and ML", "top_k": 3}'
```

### Delete
```bash
curl -X POST http://localhost:8787/delete \
  -H "Content-Type: application/json" \
  -d '{"chunk_ids": ["chunk_123"]}'
```

---

## 🎯 **Common Patterns**

### Pagination
```typescript
let offset = 0
while (true) {
  const {chunks, has_more} = await remoteClient.listChunks(50, offset)
  // Process chunks...
  if (!has_more) break
  offset += 50
}
```

### Clean Old Data
```typescript
const {chunks} = await remoteClient.listChunks(1000, 0)
const oldIds = chunks
  .filter(c => c.created_at < Date.now() - 86400000)
  .map(c => c.chunk_id)
await remoteClient.deleteChunks(oldIds)
```

### Debug Storage
```typescript
// Quick stats
const count = await remoteClient.getChunkCount()

// View recent chunks
const {chunks} = await remoteClient.listChunks(10, 0)

// Test search
const results = await remoteClient.search("test query", 3)
```

---

## 📊 **Response Formats**

### List Response
```json
{
  "ok": true,
  "chunks": [
    {
      "chunk_id": "chunk_123",
      "point_id": 12345678901234567890,
      "text": "Full text...",
      "created_at": 1770544575757,
      "text_preview": "First 100 chars..."
    }
  ],
  "total_count": 150,
  "has_more": true
}
```

### Delete Response
```json
{
  "ok": true,
  "deleted_count": 3
}
```

### Count Response
```json
{
  "ok": true,
  "count": 150,
  "collection": "latest_session"
}
```

---

## ⚡ **Performance Tips**

1. **Use COUNT for stats** (faster than LIST)
2. **Paginate with small limits** (50-100 chunks per page)
3. **Delete in batches** (not one-by-one)
4. **Search with appropriate top_k** (3-10, not 100)

---

## 🐛 **Troubleshooting**

### "No chunks found"
```typescript
const count = await remoteClient.getChunkCount()
// If 0: No data ingested yet
```

### "Delete not working"
```typescript
// Check chunk exists first
const {chunks} = await remoteClient.listChunks()
console.log(chunks.map(c => c.chunk_id))
```

### "List returns empty"
```bash
# Check collection directly
curl http://localhost:8787/count
```

---

## 📚 **Full Documentation**

- Complete Guide: `VECTORDB_CRUD_GUIDE.md`
- Test Script: `server/vector_memory/test_crud_operations.py`
- Point ID Fix: `QDRANT_POINT_ID_FIX.md`
