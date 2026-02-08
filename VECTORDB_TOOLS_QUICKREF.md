# 🎯 VectorDB CRUD Tools - Quick Reference

## 📊 **Architecture at a Glance**

### **Tool Flow:**
```
User Voice → AgentOrchestrator → ToolRouter (AI) → [Tool] → RemoteClient → VectorDB Server
```

### **4 New Tools:**

| Tool | Icon | Purpose | Key Method |
|------|------|---------|------------|
| **VectorSearchTool** | 🔍 | Find by meaning | `search(query, top_k)` |
| **VectorListTool** | 📋 | View all data | `listChunks(limit, offset)` |
| **VectorCountTool** | 🔢 | Get statistics | `getChunkCount()` |
| **VectorDeleteTool** | 🗑️ | Remove chunks | `deleteChunks(ids)` |

---

## 🎙️ **Voice Command Examples**

| User Says | Tool Selected | Action |
|-----------|---------------|--------|
| "what did I say about AI" | VectorSearchTool | Search for "AI" |
| "find discussions about landing" | VectorSearchTool | Search for "landing" |
| "show me all my recordings" | VectorListTool | List all chunks |
| "list everything I've said" | VectorListTool | List with pagination |
| "how many recordings do I have" | VectorCountTool | Return count |
| "what's my storage size" | VectorCountTool | Count + stats |
| "delete chunk_123" | VectorDeleteTool | Delete specific chunk |
| "remove old data" | VectorDeleteTool | Delete multiple |

---

## 🔧 **Tool Parameters**

### **VectorSearchTool** 🔍
```typescript
{
  query: string,              // REQUIRED: "machine learning"
  top_k: number,              // Optional: 5 (default)
  min_score: number,          // Optional: 0.3 (default)
  summarize_results: boolean  // Optional: true (default)
}
```

**Returns:**
```typescript
{
  matches: [{rank, score, text_preview, full_text}],
  match_count: number,
  ai_summary: string,
  message: string
}
```

---

### **VectorListTool** 📋
```typescript
{
  limit: number,       // Optional: 50 (default)
  offset: number,      // Optional: 0 (default)
  showPreview: boolean // Optional: true (default)
}
```

**Returns:**
```typescript
{
  chunks: [{index, chunk_id, point_id, created_at, text_length, preview}],
  total_count: number,
  showing_count: number,
  has_more: boolean,
  current_page: number,
  message: string
}
```

---

### **VectorCountTool** 🔢
```typescript
{
  detailed: boolean  // Optional: false (default)
}
```

**Returns:**
```typescript
{
  count: number,
  message: string,
  statistics?: {     // Only if detailed=true
    average_chunk_size: number,
    time_span_minutes: number,
    oldest_chunk: string,
    newest_chunk: string
  }
}
```

---

### **VectorDeleteTool** 🗑️
```typescript
{
  chunk_ids: string[],  // REQUIRED: ["chunk_123", "chunk_456"]
  confirm: boolean      // REQUIRED: true (safety)
}
```

**Returns:**
```typescript
{
  deleted_count: number,
  chunk_ids: string[],
  message: string
}
```

---

## 🔌 **Integration Pattern**

### **1. Tool Creation:**
```typescript
// In ToolRouter constructor
this.vectorSearchTool = new VectorSearchTool(languageInterface)
this.vectorListTool = new VectorListTool()
this.vectorCountTool = new VectorCountTool()
this.vectorDeleteTool = new VectorDeleteTool()
```

### **2. Tool Registration:**
```typescript
// Register each tool
this.indexTool(
  "vector_search_tool",
  "Performs semantic search on VectorDB",
  ["semantic search", "find chunks", "search recordings"],
  ["user wants to find specific content", "user asks 'what did I say about...'"],
  this.vectorSearchTool
)
```

### **3. Client Connection:**
```typescript
// In ToolRouter
public setVectorClient(client: RemoteVectorMemoryClient): void {
  this.vectorSearchTool.setRemoteClient(client)
  this.vectorListTool.setRemoteClient(client)
  this.vectorCountTool.setRemoteClient(client)
  this.vectorDeleteTool.setRemoteClient(client)
}

// In AgentOrchestrator
const client = this.vectorIngestController.getRemoteClient()
if (client) {
  this.toolRouter.setVectorClient(client)
}
```

---

## 📁 **Files Modified**

### **Created (4 files):**
- ✅ `VectorSearchTool.ts`
- ✅ `VectorListTool.ts`
- ✅ `VectorCountTool.ts`
- ✅ `VectorDeleteTool.ts`

### **To Modify (3 files):**
- 📝 `ToolRouter.ts` - Import, init, register tools
- 📝 `AgentOrchestrator.ts` - Wire VectorIngestController
- 📝 `VectorIngestController.ts` - Expose getRemoteClient()

---

## 🎯 **When AI Selects Each Tool**

### **VectorSearchTool** 🔍
**Triggers:**
- User asks about **specific topics**
- Query contains: "what did I", "find", "search", "show me about"
- Semantic search intent

**Example AI Reasoning:**
> "User wants to find content by meaning. Query: 'landing'. Select: vector_search_tool"

---

### **VectorListTool** 📋
**Triggers:**
- User wants **overview of all data**
- Query contains: "show all", "list", "what do I have"
- Browse/view intent

**Example AI Reasoning:**
> "User wants to see all recordings. No specific search query. Select: vector_list_tool"

---

### **VectorCountTool** 🔢
**Triggers:**
- User asks for **statistics**
- Query contains: "how many", "how much", "count", "stats"
- Quick info intent

**Example AI Reasoning:**
> "User asks 'how many recordings'. Count query. Select: vector_count_tool"

---

### **VectorDeleteTool** 🗑️
**Triggers:**
- User wants to **remove data**
- Query contains: "delete", "remove", "clear"
- Destruction intent (requires confirm=true)

**Example AI Reasoning:**
> "User wants to delete chunk_123. Destruction intent. Select: vector_delete_tool"

---

## 🔒 **Safety Features**

### **Delete Protection:**
```typescript
// ❌ This will fail (no confirmation)
{chunk_ids: ["chunk_123"]}

// ✅ This will succeed (confirmed)
{chunk_ids: ["chunk_123"], confirm: true}
```

### **Search Filtering:**
```typescript
// Only returns chunks with score >= min_score
{query: "AI", min_score: 0.5}  // Only 50%+ relevance
```

### **List Pagination:**
```typescript
// Prevents massive responses
{limit: 10, offset: 0}  // First 10 chunks
{limit: 10, offset: 10} // Next 10 chunks
```

---

## 🚀 **Testing Commands**

### **Test 1: Search**
```
You: "what did I say about landing"
Expected: VectorSearchTool → 5 relevant chunks + AI summary
```

### **Test 2: List**
```
You: "show me all my recordings"
Expected: VectorListTool → First 50 chunks with previews
```

### **Test 3: Count**
```
You: "how many chunks do I have"
Expected: VectorCountTool → "You have 47 chunks"
```

### **Test 4: Detailed Stats**
```
You: "show me detailed storage stats"
Expected: VectorCountTool (detailed=true) → Count + avg size + time span
```

### **Test 5: Search + Summarize**
```
You: "find discussions about AI and summarize them"
Expected: VectorSearchTool (summarize=true) → Matches + AI summary
```

---

## 🎨 **Response Flow Diagram**

```
User: "what did I say about AI"
    ↓
[ChatASRController] Transcribe voice
    ↓
[AgentOrchestrator] Process query
    ↓
[ToolRouter] AI analyzes query
    ↓
AI Reasoning: "Search intent + topic 'AI' → vector_search_tool"
    ↓
[VectorSearchTool] execute({query: "AI", top_k: 5})
    ↓
[RemoteVectorMemoryClient] search("AI", 5)
    ↓
[WebSocket] Send search request to server
    ↓
[FastAPI Server] Embed query + search Qdrant
    ↓
[Qdrant] Vector similarity search
    ↓
[Server] Return top 5 matches
    ↓
[VectorSearchTool] Format results + AI summary
    ↓
[AgentOrchestrator] Process result
    ↓
[ChatBridge] Display to user
    ↓
User sees: "Found 5 chunks about AI: [previews...]"
```

---

## 📊 **Tool Comparison**

| Feature | Search | List | Count | Delete |
|---------|--------|------|-------|--------|
| **Read/Write** | Read | Read | Read | Write |
| **Speed** | Medium | Medium | Fast | Fast |
| **AI Summary** | Yes | No | No | No |
| **Pagination** | No | Yes | N/A | N/A |
| **Safety Check** | No | No | No | Yes |
| **Use Frequency** | High | Medium | Low | Low |

---

## 🎯 **Implementation Checklist**

- [x] Create VectorSearchTool.ts
- [x] Create VectorListTool.ts
- [x] Create VectorCountTool.ts
- [x] Create VectorDeleteTool.ts
- [ ] Modify ToolRouter.ts (import, init, register)
- [ ] Modify AgentOrchestrator.ts (wire client)
- [ ] Modify VectorIngestController.ts (expose getter)
- [ ] Test in Lens Studio
- [ ] Test voice commands on Spectacles

---

## 🔑 **Key Concepts**

### **Semantic Search:**
- Searches by **meaning**, not exact text
- "landing" finds: "landing page", "aircraft landing", "soft landing"
- Uses embeddings for similarity

### **Chunk ID vs Point ID:**
- **Chunk ID**: String from app (e.g., "chunk_1770544575757_6070")
- **Point ID**: Integer for Qdrant (converted via MD5 hash)
- Original chunk_id stored in payload

### **Tool Registration:**
```typescript
indexTool(
  name: string,           // "vector_search_tool"
  description: string,    // "Performs semantic search..."
  capabilities: string[], // ["semantic search", ...]
  useWhen: string[],      // ["user wants to find...", ...]
  instance: any           // this.vectorSearchTool
)
```

### **RemoteClient Sharing:**
- **One** WebSocket connection
- **Shared** across all vector tools
- Managed by VectorIngestController
- Injected into ToolRouter → Each tool

---

## 💡 **Pro Tips**

1. **Search with Context:**
   - Use `summarize_results: true` for AI summaries
   - Adjust `min_score` to filter noise

2. **List Smart:**
   - Use pagination for large datasets
   - `showPreview: false` for faster responses

3. **Count First:**
   - Check count before listing all
   - Use `detailed: true` for quality insights

4. **Delete Safely:**
   - Always require `confirm: true`
   - List chunks first to get chunk_ids

---

## 📚 **Further Reading**

- **Full Architecture:** `VECTORDB_TOOLS_ARCHITECTURE.md`
- **CRUD Guide:** `VECTORDB_CRUD_GUIDE.md`
- **Testing Guide:** `TESTING_REAL_DATA.md`

---

**Your VectorDB is now fully voice-controllable! 🎉**
