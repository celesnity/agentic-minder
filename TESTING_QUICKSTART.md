# 🎯 VectorDB Testing - Quick Start Guide

## 🚀 **How to Test CRUD with Your Real Data**

### **Step 1: Collect Data**
```bash
# Open Lens Studio and record for 1-2 minutes
# Speak naturally about any topic
# Wait for chunks to be stored
```

### **Step 2: Run Test Script**
```bash
cd server/vector_memory
python test_real_data.py
```

### **Step 3: Follow Interactive Prompts**
- View your recordings
- Search by topic
- Export backup
- Delete old data

---

## 📋 **What You Can Test**

| Operation | What It Does | Example |
|-----------|--------------|---------|
| **LIST** | View all your recordings | See what you've recorded |
| **SEARCH** | Find by meaning | "what did I say about AI" |
| **COUNT** | Quick stats | Total chunks in DB |
| **DELETE** | Remove specific/old chunks | Clean up old recordings |
| **EXPORT** | Backup to JSON | Save your data |
| **ANALYZE** | Quality metrics | Size, time, distribution |

---

## 🎯 **Example Workflow**

```bash
# Terminal 1: Start server
./setup_local_embeddings.sh

# Terminal 2: Collect data
# Open Lens Studio, record 1-2 minutes

# Terminal 3: Test CRUD
cd server/vector_memory
python test_real_data.py
```

---

## 💡 **Quick Commands**

### **Check Server**
```bash
curl http://localhost:8787/health
```

### **Quick Stats**
```bash
curl http://localhost:8787/count
```

### **List Data**
```bash
curl "http://localhost:8787/list?limit=10"
```

### **Search**
```bash
curl -X POST http://localhost:8787/search \
  -H "Content-Type: application/json" \
  -d '{"query": "landing", "top_k": 3}'
```

---

## 📚 **Documentation**

- **`test_real_data.py`** - Interactive test script (THIS!)
- **`TESTING_REAL_DATA.md`** - Complete guide
- **`VECTORDB_CRUD_GUIDE.md`** - Full CRUD documentation
- **`VECTORDB_CRUD_QUICKREF.md`** - Quick reference

---

## ✅ **Ready to Test!**

1. ✅ Server running (`./setup_local_embeddings.sh`)
2. ✅ Data collected (record in Lens Studio)
3. ✅ Run test (`python test_real_data.py`)
4. ✅ Explore your data interactively!

**All operations work with YOUR actual recordings! 🎉**
