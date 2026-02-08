# 🔧 EXACT IMPLEMENTATION STEPS

## Step-by-Step Integration Guide

### **Step 1: Modify ToolRouter.ts**

**Location:** `Assets/AgenticPlayground/Scripts/Tools/ToolRouter.ts`

#### **1.1 Add Imports (after line 8)**

```typescript
import {SummaryTool} from "./SummaryTool"
import {VectorSearchTool} from "./VectorSearchTool"
import {VectorListTool} from "./VectorListTool"
import {VectorCountTool} from "./VectorCountTool"
import {VectorDeleteTool} from "./VectorDeleteTool"
import {RemoteVectorMemoryClient} from "../Storage/RemoteVectorMemoryClient"
```

#### **1.2 Add Properties (after line 30)**

```typescript
  private generalConversationTool: GeneralConversationTool
  // Add these 4 new properties:
  private vectorSearchTool: VectorSearchTool
  private vectorListTool: VectorListTool
  private vectorCountTool: VectorCountTool
  private vectorDeleteTool: VectorDeleteTool
```

#### **1.3 Initialize Tools in Constructor (after line 39)**

```typescript
    const summaryTool = new SummaryTool(languageInterface)
    const spatialTool = new SpatialTool(languageInterface)
    
    // Add these 4 new tool initializations:
    this.vectorSearchTool = new VectorSearchTool(languageInterface)
    this.vectorListTool = new VectorListTool()
    this.vectorCountTool = new VectorCountTool()
    this.vectorDeleteTool = new VectorDeleteTool()
```

#### **1.4 Index VectorDB Tools (after line 115 - before the debug logging)**

```typescript
    })

    // Add these 4 tool registrations:
    this.indexTool("vector_search_tool", {
      name: "vector_search_tool",
      description: "Performs semantic search on VectorDB to find relevant recorded chunks by meaning",
      capabilities: [
        "Semantic search in recorded transcripts",
        "Find chunks by meaning (not exact text)",
        "Search past recordings and lectures",
        "Query stored knowledge base"
      ],
      useWhen: [
        'User wants to find specific content in recordings (e.g., "what did I say about...")',
        "User asks to search for topics in stored data",
        'User queries past recordings (e.g., "find discussions about X")',
        "User wants to retrieve information from recorded content"
      ],
      instance: this.vectorSearchTool
    })

    this.indexTool("vector_list_tool", {
      name: "vector_list_tool",
      description: "Lists all chunks stored in VectorDB with pagination support",
      capabilities: [
        "View all recorded chunks",
        "Browse stored recordings with previews",
        "List data with pagination",
        "Show overview of stored content"
      ],
      useWhen: [
        'User wants to see all recordings (e.g., "show me all my data")',
        'User asks "what do I have stored"',
        "User requests data overview or inventory",
        "User wants to browse recorded content"
      ],
      instance: this.vectorListTool
    })

    this.indexTool("vector_count_tool", {
      name: "vector_count_tool",
      description: "Gets statistics about stored chunks in VectorDB",
      capabilities: [
        "Count total chunks stored",
        "Provide storage statistics",
        "Show database metrics",
        "Analyze data quality"
      ],
      useWhen: [
        'User asks "how many recordings do I have"',
        "User requests storage statistics or metrics",
        "User checks database state",
        'User wants quick overview (e.g., "what\'s my storage size")'
      ],
      instance: this.vectorCountTool
    })

    this.indexTool("vector_delete_tool", {
      name: "vector_delete_tool",
      description: "Deletes specific chunks from VectorDB (requires confirmation)",
      capabilities: [
        "Delete specific chunks by ID",
        "Remove unwanted recordings",
        "Clean up old data",
        "Clear selected chunks"
      ],
      useWhen: [
        "User wants to delete specific chunks by ID",
        'User requests data cleanup (e.g., "remove old recordings")',
        'User says "delete chunk_XXX"',
        "User clears unwanted data"
      ],
      instance: this.vectorDeleteTool
    })

    if (this.enableDebugLogging) {
```

#### **1.5 Add setVectorClient Method (after line 145 - after setChatStorage)**

```typescript
  /**
   * Set the chat storage for tools that need it
   */
  public setChatStorage(chatStorage: ChatStorage): void {
    if (this.diagramCreatorTool) {
      this.diagramCreatorTool.setChatStorage(chatStorage)
      print("ToolRouter: Connected ChatStorage to DiagramCreatorTool")
    }
  }

  // Add this new method:
  /**
   * Set the RemoteVectorMemoryClient for VectorDB tools
   */
  public setVectorClient(client: RemoteVectorMemoryClient): void {
    this.vectorSearchTool.setRemoteClient(client)
    this.vectorListTool.setRemoteClient(client)
    this.vectorCountTool.setRemoteClient(client)
    this.vectorDeleteTool.setRemoteClient(client)
    print("ToolRouter: ✅ Connected RemoteVectorMemoryClient to all VectorDB tools")
  }
```

---

### **Step 2: Modify VectorIngestController.ts**

**Location:** `Assets/AgenticPlayground/Scripts/Components/VectorIngestController.ts`

#### **2.1 Add Public Getter for RemoteClient**

Find the class properties section and add this getter method (around line 50-60, after the private properties):

```typescript
  // Existing properties...
  private remoteClient: RemoteVectorMemoryClient | null = null

  // Add this public getter:
  /**
   * Get the RemoteVectorMemoryClient instance for use by tools
   * @returns RemoteVectorMemoryClient if remote mode is enabled, null otherwise
   */
  public getRemoteClient(): RemoteVectorMemoryClient | null {
    return this.useRemoteVectorService ? this.remoteClient : null
  }
```

---

### **Step 3: Modify AgentOrchestrator.ts**

**Location:** `Assets/AgenticPlayground/Scripts/Agents/AgentOrchestrator.ts`

#### **3.1 Add Input for VectorIngestController**

Find the existing `@input` properties section and add:

```typescript
  @input
  summaryStorage: SummaryStorage | null = null

  @input
  chatStorage: ChatStorage | null = null

  // Add this new input:
  @input
  vectorIngestController: VectorIngestController | null = null
```

**IMPORTANT:** You'll need to import `VectorIngestController`:

```typescript
import {VectorIngestController} from "../Components/VectorIngestController"
```

#### **3.2 Wire VectorClient to ToolRouter in Initialize Method**

Find the `initialize()` method (or wherever you wire up dependencies) and add:

```typescript
  // Existing wiring...
  if (this.summaryStorage) {
    this.toolRouter.setSummaryStorage(this.summaryStorage)
  }

  if (this.chatStorage) {
    this.toolRouter.setChatStorage(this.chatStorage)
  }

  // Add this new wiring:
  if (this.vectorIngestController) {
    const vectorClient = this.vectorIngestController.getRemoteClient()
    if (vectorClient) {
      this.toolRouter.setVectorClient(vectorClient)
      print("AgentOrchestrator: ✅ Wired VectorDB client to ToolRouter")
    } else {
      print("AgentOrchestrator: ⚠️ VectorIngestController present but no remote client available")
    }
  } else {
    print("AgentOrchestrator: ℹ️ No VectorIngestController assigned - VectorDB tools will be unavailable")
  }
```

---

### **Step 4: Update Scene.scene (Wire AgentOrchestrator)**

**Location:** `Assets/Scene.scene`

#### **4.1 Find AgentOrchestrator ScriptComponent Entry**

Search for the `AgentOrchestrator` script component definition. It should look something like:

```yaml
- !<ScriptComponent>
  Name: AgentOrchestrator
  ScriptAsset: !<reference> GUID_OF_AGENT_ORCHESTRATOR_SCRIPT
  ScriptInputs:
    - !<MappingBased.AssignableType>
      name: summaryStorage
      value: !<reference> SUMMARY_STORAGE_SCENE_OBJECT_ID
    - !<MappingBased.AssignableType>
      name: chatStorage
      value: !<reference> CHAT_STORAGE_SCENE_OBJECT_ID
    # ... other inputs
```

#### **4.2 Add VectorIngestController Input**

Add this new input entry to the `ScriptInputs` array:

```yaml
    - !<MappingBased.AssignableType>
      name: vectorIngestController
      value: !<reference> ID_OF_VECTOR_INGEST_CONTROLLER_SCENE_OBJECT
```

**How to find the VectorIngestController ID:**
1. Search `Scene.scene` for `"VectorIngestController"`
2. Find the SceneObject that has this script component
3. Copy its ID (e.g., `id: 12345`)
4. Use that ID in the reference above

**Example:**
```yaml
- !<SceneObject>
  id: 83746521  # This is the ID you need
  name: SummaryStorage
  components:
    - !<ScriptComponent>
      Name: VectorIngestController
      ScriptAsset: !<reference> 1770365432742
```

Then in AgentOrchestrator's inputs:
```yaml
    - !<MappingBased.AssignableType>
      name: vectorIngestController
      value: !<reference> 83746521  # Use the ID from above
```

---

### **Step 5: Update ToolRouter AI Routing Rules**

**Location:** `ToolRouter.ts` - in the `getAIRoutingDecision` method (around line 228)

#### **5.1 Update Routing Rules**

Replace the existing `ROUTING RULES` section with this enhanced version:

```typescript
ROUTING RULES:
1. If user asks about "the lecture" or lecture content, and summary context is available, use "summary_tool"
2. If user requests diagrams, visualizations, or mind maps, use "diagram_tool"  
3. If user asks about current/live environment or "what do you see", use "spatial_tool"
4. If user wants to SEARCH recorded data (e.g., "what did I say about...", "find discussions about..."), use "vector_search_tool"
5. If user wants to LIST/VIEW all recordings (e.g., "show all my data", "what do I have"), use "vector_list_tool"
6. If user asks HOW MANY/COUNT (e.g., "how many recordings", "storage stats"), use "vector_count_tool"
7. If user wants to DELETE data (e.g., "delete chunk_XXX", "remove recordings"), use "vector_delete_tool"
8. For general questions without specific tool needs, use "general_conversation"

Respond with ONLY the tool name (e.g., "summary_tool", "diagram_tool", "vector_search_tool", "general_conversation").
```

---

## 📋 **Complete Files Checklist**

### **Created (4 new files):**
- ✅ `VectorSearchTool.ts`
- ✅ `VectorListTool.ts`
- ✅ `VectorCountTool.ts`
- ✅ `VectorDeleteTool.ts`

### **Modified (4 files):**
- [ ] `ToolRouter.ts` - Import, init, register, add setVectorClient()
- [ ] `VectorIngestController.ts` - Add getRemoteClient() getter
- [ ] `AgentOrchestrator.ts` - Add input, import, wire client
- [ ] `Scene.scene` - Wire vectorIngestController to AgentOrchestrator

---

## 🧪 **Testing Steps**

### **1. Verify Initialization Logs**

After restarting Lens Studio, look for these logs:

```
ToolRouter: 🧠 AI-powered intelligent tool router initialized with 8 indexed tools
ToolRouter: 📚 Tools indexed: diagram_tool, summary_tool, spatial_tool, general_conversation, vector_search_tool, vector_list_tool, vector_count_tool, vector_delete_tool

VectorSearchTool: 🔍 Vector search tool initialized
VectorListTool: 📋 Vector list tool initialized
VectorCountTool: 🔢 Vector count tool initialized
VectorDeleteTool: 🗑️ Vector delete tool initialized

ToolRouter: ✅ Connected RemoteVectorMemoryClient to all VectorDB tools
AgentOrchestrator: ✅ Wired VectorDB client to ToolRouter
```

### **2. Test Voice Commands**

#### **Test 1: Search**
```
You: "what did I say about landing"
Expected Log:
  ToolRouter: 🧠 AI routing decision: "vector_search_tool"
  VectorSearchTool: 🔍 Searching for: "landing"
  VectorSearchTool: ✅ Found X relevant matches
```

#### **Test 2: List**
```
You: "show me all my recordings"
Expected Log:
  ToolRouter: 🧠 AI routing decision: "vector_list_tool"
  VectorListTool: 📋 Listing chunks (limit: 50, offset: 0)
  VectorListTool: ✅ Retrieved X chunks
```

#### **Test 3: Count**
```
You: "how many recordings do I have"
Expected Log:
  ToolRouter: 🧠 AI routing decision: "vector_count_tool"
  VectorCountTool: 🔢 Getting chunk count...
  VectorCountTool: ✅ VectorDB contains X chunks
```

---

## ⚠️ **Common Issues & Solutions**

### **Issue 1: Tools Not Showing in Logs**

**Symptom:**
```
ToolRouter: 🧠 AI-powered intelligent tool router initialized with 4 indexed tools
(Missing the vector tools)
```

**Solution:**
- Check imports in `ToolRouter.ts` (Step 1.1)
- Verify tool initialization in constructor (Step 1.3)
- Confirm tool indexing calls (Step 1.4)

---

### **Issue 2: "VectorDB client not configured" Error**

**Symptom:**
```
VectorSearchTool: ❌ ERROR - VectorDB client not configured
```

**Solution:**
- Check `setVectorClient()` method exists in `ToolRouter.ts` (Step 1.5)
- Verify `getRemoteClient()` in `VectorIngestController.ts` (Step 2.1)
- Confirm wiring in `AgentOrchestrator.ts` (Step 3.2)
- Check `Scene.scene` wiring (Step 4)

---

### **Issue 3: AI Always Routes to general_conversation**

**Symptom:**
```
ToolRouter: 🧠 AI routing decision: "general_conversation"
(Even when asking "what did I say about X")
```

**Solution:**
- Update AI routing rules in `getAIRoutingDecision` (Step 5.1)
- Verify tool capabilities and useWhen arrays are clear
- Check AI routing prompt includes VectorDB tools

---

### **Issue 4: RemoteClient is null**

**Symptom:**
```
AgentOrchestrator: ⚠️ VectorIngestController present but no remote client available
```

**Solution:**
- Check `VectorIngestController` has `useRemoteVectorService: true` in Scene.scene
- Verify `internetModule` is assigned in Scene.scene
- Confirm server is running and connected

---

## 🎯 **Success Criteria**

You'll know it's working when:

1. ✅ **8 tools indexed** in initialization logs
2. ✅ **RemoteVectorMemoryClient connected** to all tools
3. ✅ **AI routing selects vector tools** for appropriate queries
4. ✅ **Search returns results** from VectorDB
5. ✅ **List shows chunks** with previews
6. ✅ **Count returns accurate number**
7. ✅ **Delete removes chunks** (with confirmation)

---

## 📊 **Final Architecture**

```
User Voice → ChatASR → AgentOrchestrator
                            ↓
                      ToolRouter (AI decides)
                            ↓
        ┌─────────────────────────────────────┐
        │   8 Tools Available                  │
        ├─────────────────────────────────────┤
        │ 1. general_conversation             │
        │ 2. summary_tool                     │
        │ 3. spatial_tool                     │
        │ 4. diagram_tool                     │
        │ 5. vector_search_tool (NEW)         │
        │ 6. vector_list_tool (NEW)           │
        │ 7. vector_count_tool (NEW)          │
        │ 8. vector_delete_tool (NEW)         │
        └─────────────────────────────────────┘
                            ↓
              RemoteVectorMemoryClient
                            ↓
                  VectorDB Server (FastAPI)
                            ↓
                    Qdrant Database
```

---

**Ready to implement? Let me know if you want me to make these changes directly!**
