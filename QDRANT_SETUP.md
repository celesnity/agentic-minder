# Qdrant VectorDB Setup Guide

## 🎯 Quick Start

This guide will help you set up Qdrant VectorDB for the Agentic Minder project.

---

## 📋 Prerequisites

- Python 3.8 or higher
- pip (Python package manager)
- macOS, Linux, or Windows

---

## 🚀 Installation Steps

### **Option 1: Using the Setup Script (Recommended)**

```bash
# Navigate to project directory
cd /path/to/agentic-minder

# Run the Qdrant server startup script
./restart_vector_server.sh
```

This script will:
1. Check if Qdrant is installed
2. Install dependencies if needed
3. Start the Qdrant server on `http://localhost:8787`

---

### **Option 2: Manual Installation**

#### **Step 1: Install Python Dependencies**

```bash
cd server/vector_memory

# Create virtual environment (optional but recommended)
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

#### **Step 2: Install Qdrant**

The server uses Qdrant in-memory mode by default (no separate Qdrant installation needed).

For persistent storage, you can install Qdrant separately:

```bash
# Using Docker (recommended for production)
docker pull qdrant/qdrant
docker run -p 6333:6333 -p 6334:6334 qdrant/qdrant

# Or using pip (for development)
pip install qdrant-client
```

#### **Step 3: Start the VectorDB Server**

```bash
cd server/vector_memory
python main.py
```

The server will start on `http://localhost:8787`

---

## 🔧 Configuration

### **Environment Variables**

Create a `.env` file in `server/vector_memory/` (optional):

```bash
# Qdrant Configuration
QDRANT_URL=:memory:  # Use in-memory mode (default)
# QDRANT_URL=http://localhost:6333  # Use external Qdrant instance

# Vector Collection
VECTOR_COLLECTION=agentic_minder_vectors

# Embedding Model
EMBED_MODEL=all-mpnet-base-v2
EMBED_DIMENSIONS=768

# Server Configuration
SERVER_HOST=0.0.0.0
SERVER_PORT=8787
```

### **Server Configuration in `main.py`**

The server is pre-configured with sensible defaults:
- **Port:** 8787
- **WebSocket endpoint:** `/ws`
- **Collection:** `agentic_minder_vectors`
- **Embedding model:** `all-mpnet-base-v2` (768 dimensions)

---

## 📁 Project Structure

```
agentic-minder/
├── server/
│   └── vector_memory/
│       ├── main.py              # VectorDB server
│       ├── requirements.txt     # Python dependencies
│       └── .venv/              # Virtual environment (gitignored)
├── restart_vector_server.sh    # Quick start script
└── Assets/
    └── AgenticPlayground/
        └── Scripts/
            └── Storage/
                └── RemoteVectorMemoryClient.ts  # Client
```

---

## ✅ Verification

### **1. Check Server is Running**

```bash
# Server should show:
INFO:     Uvicorn running on http://0.0.0.0:8787 (Press CTRL+C to quit)
INFO:     Started server process
INFO:     Waiting for application startup.
INFO:     Application startup complete.
```

### **2. Test WebSocket Connection**

```bash
# In a new terminal
curl http://localhost:8787/health

# Should return:
{"status": "healthy"}
```

### **3. Check Logs**

```bash
# Server logs
tail -f server/vector_memory/logs/server.log

# Or check the main log file
tail -f logger_db.log
```

---

## 🧪 Testing

### **Test Ingestion**

```bash
# Start the server
./restart_vector_server.sh

# In Lens Studio:
# 1. Run the Lens in Preview mode
# 2. Start recording audio
# 3. Say something
# 4. Stop recording
# 5. Check logs for ingestion confirmation
```

### **Test Retrieval**

```bash
# After ingesting data:
# 1. Ask a question related to what you said
# 2. Check logs for VectorDB search
# 3. Verify AI response includes your recorded content
```

---

## 🐛 Troubleshooting

### **Port Already in Use**

```bash
# Find process using port 8787
lsof -i :8787

# Kill the process
kill -9 <PID>

# Or change the port in main.py
```

### **Module Not Found Errors**

```bash
# Reinstall dependencies
cd server/vector_memory
pip install -r requirements.txt
```

### **WebSocket Connection Failed**

```bash
# Check firewall settings
# Ensure port 8787 is not blocked

# Check server logs
tail -f logger_db.log
```

### **No Data Retrieved**

```bash
# Verify data was ingested
# Check VectorIngestController logs in Lens Studio

# Verify collection exists
# Check server logs for collection creation
```

---

## 📚 Dependencies

### **Python Packages (requirements.txt)**

```
fastapi>=0.104.0
uvicorn[standard]>=0.24.0
websockets>=12.0
qdrant-client>=1.7.0
sentence-transformers>=2.2.2
pydantic>=2.0.0
python-multipart>=0.0.6
```

### **System Requirements**

- **RAM:** 2GB minimum (4GB recommended for embedding models)
- **Disk:** 500MB for dependencies + storage for vectors
- **CPU:** Any modern CPU (GPU optional for faster embeddings)

---

## 🔐 Security Notes

### **For Development:**
- Server runs on `0.0.0.0:8787` (accessible from local network)
- No authentication required
- WebSocket connections are unencrypted

### **For Production:**
- Use HTTPS/WSS for encrypted connections
- Implement authentication (API keys, OAuth)
- Run behind a reverse proxy (nginx, Apache)
- Use external Qdrant instance with authentication

---

## 🚀 Quick Commands Reference

```bash
# Start server
./restart_vector_server.sh

# Stop server
# Press Ctrl+C in the terminal running the server

# Check server status
curl http://localhost:8787/health

# View logs
tail -f logger_db.log

# Restart server
# Press Ctrl+C, then run ./restart_vector_server.sh again
```

---

## 📖 Additional Resources

- [Qdrant Documentation](https://qdrant.tech/documentation/)
- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [Sentence Transformers](https://www.sbert.net/)

---

## 💡 Tips

1. **Use in-memory mode for development** (faster, no persistence needed)
2. **Use external Qdrant for production** (persistent storage, better performance)
3. **Monitor server logs** to debug issues
4. **Keep the server running** while using the Lens
5. **Restart server** after code changes to `main.py`

---

## ✅ Success Checklist

- [ ] Python 3.8+ installed
- [ ] Dependencies installed (`pip install -r requirements.txt`)
- [ ] Server starts without errors
- [ ] WebSocket endpoint accessible at `ws://localhost:8787/ws`
- [ ] Health check returns `{"status": "healthy"}`
- [ ] Lens Studio can connect to server
- [ ] Data ingestion works (check logs)
- [ ] Data retrieval works (check logs)

---

**Need help?** Check the troubleshooting section or review the server logs at `logger_db.log`.
