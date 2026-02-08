# 🧪 Real-World VectorDB Testing Guide

**Script:** `test_real_data.py`  
**Purpose:** Test CRUD operations on ACTUAL data collected by your Spectacles

---

## 🚀 Quick Start

### **Step 1: Collect Some Data**
1. Open Lens Studio
2. Start recording with Spectacles (or preview mode)
3. Speak for 1-2 minutes
4. Stop recording

### **Step 2: Run the Test Script**
```bash
cd server/vector_memory
python test_real_data.py
```

---

## 📋 What the Script Does

### **1. Server Health Check** 🏥
- Verifies VectorDB server is running
- Shows embedding model and vector size
- Displays connection status

### **2. Collection Statistics** 📊
- Total chunks in database
- Collection name
- Current state

### **3. List Your Real Data** 📋
- Shows all chunks you've recorded
- Displays timestamps (when recorded)
- Shows text previews (what was said)
- Character counts

### **4. Data Quality Analysis** 📈
- Total chunks collected
- Total characters recorded
- Average chunk size
- Size distribution (small/medium/large)
- Time span of data collection

### **5. Semantic Search** 🔍
- Search your actual recordings by meaning
- Test with custom queries
- See relevance scores
- Find what you talked about

### **6. Export Data** 💾
- Save your data to JSON file
- Backup your recordings
- Timestamped filenames

### **7. Manage/Delete Chunks** 🗑️
**Options:**
- Delete specific chunks by number
- Delete oldest chunks
- Reset entire collection
- Skip deletion

---

## 🎯 Example Session

```bash
$ python test_real_data.py

╔═══════════════════════════════════════════════════════════════════╗
║  🧪 VectorDB CRUD Testing - Real-World Data Edition              ║
║  This script tests operations on YOUR actual collected data      ║
╚═══════════════════════════════════════════════════════════════════╝

ℹ️  Server: http://localhost:8787

========================================================================
  🏥 SERVER HEALTH CHECK
========================================================================

✅ Server is running!
ℹ️     - Embedding model: all-mpnet-base-v2
ℹ️     - Vector size: 768
ℹ️     - Embedding type: local_free

========================================================================
  📊 COLLECTION STATISTICS
========================================================================

✅ Collection: latest_session
✅ Total chunks: 14

========================================================================
  📋 LISTING REAL DATA (showing first 50)
========================================================================

✅ Retrieved 14 chunks (Total in DB: 14)

Chunks in your VectorDB:

[1] chunk_1770544575757_6070
    Time: 2026-02-08 01:56:15
    Length: 320 chars
    Preview: So, after. Вот. Okay. Landing, landing, landing. Oh shit. Landing, landing,...

[2] chunk_1770544580527_4303
    Time: 2026-02-08 01:56:20
    Length: 320 chars
    Preview: s help, you are reading. Thank you. That's going on. And I'll show you guy...

... (12 more chunks)

========================================================================
  📈 DATA QUALITY ANALYSIS
========================================================================

✅ Total chunks: 14
✅ Total characters: 4,468
✅ Average chunk size: 319 chars

Size Distribution:
  Small (<200 chars): 0 (0.0%)
  Medium (200-500): 14 (100.0%)
  Large (>500): 0 (0.0%)

Time Range:
  First chunk: 2026-02-08 01:56:15
  Last chunk: 2026-02-08 01:56:36
  Duration: 0.4 minutes

========================================================================
  🔍 TEST SEMANTIC SEARCH
========================================================================

ℹ️  Now let's test searching your actual data!

Example searches:
  1. what was discussed about landing
  2. felt package
  3. reading

Enter custom search query (or press Enter to use example 1): felt package

========================================================================
  🔍 SEMANTIC SEARCH: 'felt package'
========================================================================

✅ Found 5 relevant chunks:

[1] Relevance: 0.8234
    e felt package. I mean, I'm using the word felt lightly, it is nicer than...

[2] Relevance: 0.7891
    ittle felt package. Again, I'm I'm using the word felt lightly. It is nice...

[3] Relevance: 0.7456
    his out, you want to read it again with a nice little felt package. I mean...

[4] Relevance: 0.7123
    if you put this out, you want to read it again with a nice little felt pac...

[5] Relevance: 0.6890
    ou're going to read it again with a nice little felt package. I mean, I'm ...

========================================================================
  💾 EXPORT OPTIONS
========================================================================

Export data to JSON? (yes/no): yes

========================================================================
  💾 EXPORT DATA
========================================================================

✅ Exported 14 chunks to: vectordb_export_20260208_015823.json
ℹ️     File size: 5.32 KB

Manage/delete chunks? (yes/no): yes

========================================================================
  🗑️ DELETE CHUNKS (INTERACTIVE)
========================================================================

You have 14 chunks in your database.

Available options:
  1. Delete specific chunks by number
  2. Delete oldest chunks
  3. Delete all chunks (RESET)
  4. Skip deletion

Enter choice (1-4): 2

How many oldest chunks to delete? 3

⚠️  Delete 3 oldest chunks? (yes/no): yes

✅ Deleted 3 chunks!

========================================================================
  📊 FINAL STATISTICS
========================================================================

✅ Collection: latest_session
✅ Total chunks: 11

✅ Testing complete!
```

---

## 🎯 Use Cases

### **Use Case 1: Check What You Recorded**
```bash
python test_real_data.py
# View all your recordings
# Check timestamps and content
```

### **Use Case 2: Search Your Recordings**
```bash
python test_real_data.py
# Enter custom search: "what did I say about AI"
# See relevant chunks with scores
```

### **Use Case 3: Clean Up Old Data**
```bash
python test_real_data.py
# Choose option 2: Delete oldest chunks
# Keep only recent recordings
```

### **Use Case 4: Backup Your Data**
```bash
python test_real_data.py
# Export to JSON
# Get timestamped backup file
```

### **Use Case 5: Start Fresh**
```bash
python test_real_data.py
# Choose option 3: Delete all chunks
# Clean slate for new recordings
```

---

## 📊 Features

### ✅ **Interactive**
- Colorful output with emojis
- Clear prompts and confirmations
- Safe deletion (requires confirmation)

### ✅ **Informative**
- Shows exactly what data you have
- Displays timestamps (when recorded)
- Character counts and previews

### ✅ **Safe**
- Asks for confirmation before deleting
- Shows what will be deleted
- Option to cancel operations

### ✅ **Comprehensive**
- Tests all CRUD operations
- Works with YOUR actual data
- No fake test data needed

---

## 🛠️ Requirements

### **Server Must Be Running:**
```bash
# In terminal 1
cd /Users/ledinhnguyen/Git/hub/agentic-minder
./setup_local_embeddings.sh
```

### **Python Libraries:**
```bash
pip install requests  # Usually already installed
```

---

## 💡 Tips

### **1. Collect Data First**
The script works best when you have actual data:
- Record 1-2 minutes of speech in Lens Studio
- Let the system process and store chunks
- Then run the test script

### **2. Search Queries**
Use natural language:
- ✅ "what did I talk about landing"
- ✅ "discussion about packages"
- ✅ "mention of reading"
- ❌ "chunk_1770544575757_6070" (use LIST instead)

### **3. Backup Before Deletion**
- Always export to JSON before deleting
- Exported files are timestamped
- You can re-import later if needed

### **4. Check Size Distribution**
- Small chunks (<200): May be too fragmentary
- Medium (200-500): Optimal for semantic search
- Large (>500): Good context but slower

---

## 🐛 Troubleshooting

### **"Cannot connect to server"**
```bash
# Make sure server is running
./setup_local_embeddings.sh

# Check server is responding
curl http://localhost:8787/health
```

### **"VectorDB is empty"**
```bash
# Collect some data first
# 1. Open Lens Studio
# 2. Start recording
# 3. Speak for 30+ seconds
# 4. Wait for chunks to be stored
# 5. Run script again
```

### **"No matches found" in search**
```bash
# Your search query might be too specific
# Try broader queries
# Check if you have enough data (need 5+ chunks)
```

---

## 📚 Related Documentation

- **`VECTORDB_CRUD_GUIDE.md`** - Complete CRUD operations guide
- **`VECTORDB_CRUD_QUICKREF.md`** - Quick reference card
- **`test_crud_operations.py`** - Basic CRUD test (fake data)
- **`test_real_data.py`** - This script (real data)

---

## 🎯 What This Tests

### ✅ **CREATE** (Indirect)
- Verifies data was ingested from Lens Studio
- Shows chunk count increased after recording

### ✅ **READ** (Direct)
- **LIST:** Shows all your chunks
- **SEARCH:** Finds relevant chunks semantically
- **COUNT:** Quick stats

### ✅ **DELETE** (Direct)
- Delete specific chunks
- Delete oldest chunks
- Reset entire collection

### ✅ **Quality Analysis**
- Size distribution
- Time spans
- Character counts

---

## 🎉 Summary

This script lets you:
- ✅ View your actual Spectacles recordings
- ✅ Search your data semantically
- ✅ Analyze data quality
- ✅ Export backups
- ✅ Clean up old data
- ✅ Test all CRUD operations

**All with YOUR real-world data, no fake test data needed!** 🚀
