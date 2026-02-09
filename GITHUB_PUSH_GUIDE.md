# GitHub Push Guide - Agentic Minder

## 📋 Files to Push

### **Essential Code Files:**
- ✅ `Assets/AgenticPlayground/Scripts/**/*.ts` - All TypeScript code
- ✅ `server/vector_memory/main.py` - VectorDB server
- ✅ `server/vector_memory/requirements.txt` - Python dependencies

### **Setup Scripts:**
- ✅ `restart_vector_server.sh` - Qdrant server startup script
- ✅ `setup_local_embeddings.sh` - Local embeddings setup (if needed)
- ✅ `test_vectordb_setup.sh` - VectorDB testing script

### **Documentation:**
- ✅ `QDRANT_SETUP.md` - Qdrant setup guide (NEW)
- ✅ `README.md` - Project documentation
- ✅ Existing documentation files

### **Configuration:**
- ✅ `.gitignore` - Updated to exclude logs and venv
- ✅ `tsconfig.json` - TypeScript configuration
- ✅ Scene files (if needed)

---

## ❌ Files to EXCLUDE (Already in .gitignore)

- ❌ `logger_*.log` - Log files
- ❌ `server/vector_memory/.venv/` - Python virtual environment
- ❌ `server/vector_memory/__pycache__/` - Python cache
- ❌ `Cache/**` - Lens Studio cache
- ❌ `Workspaces/**` - Lens Studio workspaces

---

## 🚀 Git Commands

### **Step 1: Review Changes**
```bash
cd /Users/ledinhnguyen/Git/hub/agentic-minder

# Check current status
git status

# Review changes
git diff Assets/AgenticPlayground/Scripts/Agents/AgentOrchestrator.ts
git diff server/vector_memory/main.py
```

### **Step 2: Stage Files**
```bash
# Stage modified code files
git add Assets/AgenticPlayground/Scripts/Agents/AgentOrchestrator.ts
git add server/vector_memory/main.py

# Stage setup scripts
git add restart_vector_server.sh
git add setup_local_embeddings.sh
git add test_vectordb_setup.sh

# Stage documentation
git add QDRANT_SETUP.md
git add .gitignore

# Stage metadata files (if needed)
git add Assets/AgenticPlayground/Scripts/Agents/AgentOrchestrator.ts.meta
git add Assets/AgenticPlayground/Scripts/Components/VectorIngestController.ts.meta

# Stage scene file (if needed)
git add Assets/Scene.scene
```

### **Step 3: Commit Changes**
```bash
git commit -m "feat: Add VectorDB integration with Qdrant

- Implemented programmatic VectorDB client initialization
- Fixed VectorDB retrieval in GeneralConversationTool
- Added WebSocket error handling in server
- Changed vectorMemoryMode default to 'remote'
- Added Qdrant setup documentation and scripts
- Updated .gitignore to exclude logs and venv"
```

### **Step 4: Push to GitHub**
```bash
# Push to current branch (feature/vector-db-integration)
git push origin feature/vector-db-integration

# Or push to main branch (if ready)
# git checkout main
# git merge feature/vector-db-integration
# git push origin main
```

---

## 📝 Commit Message Template

```
feat: Add VectorDB integration with Qdrant

Changes:
- Programmatic VectorDB client initialization in AgentOrchestrator
- Automatic VectorDB retrieval in GeneralConversationTool
- WebSocket JSON error handling in server
- Qdrant setup scripts and documentation
- Updated .gitignore for Python and logs

Files:
- AgentOrchestrator.ts: Changed vectorMemoryMode default to "remote"
- main.py: Added WebSocket error handling
- restart_vector_server.sh: Qdrant server startup script
- QDRANT_SETUP.md: Comprehensive setup guide
```

---

## ✅ Pre-Push Checklist

- [ ] All code changes reviewed
- [ ] No sensitive data (API keys, passwords) in code
- [ ] Log files excluded (.gitignore updated)
- [ ] Virtual environments excluded (.gitignore updated)
- [ ] Setup scripts are executable (`chmod +x *.sh`)
- [ ] Documentation is up to date
- [ ] Commit message is descriptive
- [ ] Branch is up to date with remote

---

## 🔍 Verify Before Pushing

```bash
# Check what will be pushed
git diff origin/feature/vector-db-integration

# Check commit history
git log --oneline -5

# Verify .gitignore is working
git status  # Should NOT show .log files or .venv/
```

---

## 🎯 Quick Push (All Steps Combined)

```bash
cd /Users/ledinhnguyen/Git/hub/agentic-minder

# Stage all necessary files
git add Assets/AgenticPlayground/Scripts/Agents/AgentOrchestrator.ts \
        Assets/AgenticPlayground/Scripts/Agents/AgentOrchestrator.ts.meta \
        Assets/AgenticPlayground/Scripts/Components/VectorIngestController.ts.meta \
        Assets/Scene.scene \
        server/vector_memory/main.py \
        restart_vector_server.sh \
        setup_local_embeddings.sh \
        test_vectordb_setup.sh \
        QDRANT_SETUP.md \
        .gitignore

# Commit
git commit -m "feat: Add VectorDB integration with Qdrant

- Programmatic VectorDB client initialization
- Automatic VectorDB retrieval
- WebSocket error handling
- Qdrant setup documentation"

# Push
git push origin feature/vector-db-integration
```

---

## 📚 After Pushing

### **Create Pull Request (if using feature branch):**
1. Go to https://github.com/celesnity/agentic-minder
2. Click "Compare & pull request"
3. Add description of changes
4. Request review (if needed)
5. Merge when ready

### **Update README (if needed):**
Add a section about VectorDB setup:
```markdown
## VectorDB Setup

See [QDRANT_SETUP.md](QDRANT_SETUP.md) for detailed instructions on setting up Qdrant VectorDB.

Quick start:
\`\`\`bash
./restart_vector_server.sh
\`\`\`
```

---

## 🚨 Important Notes

1. **Don't push log files** - They're now in .gitignore
2. **Don't push virtual environments** - They're now in .gitignore
3. **Make scripts executable** - Run `chmod +x *.sh` before pushing
4. **Review changes** - Always review before pushing
5. **Test after cloning** - Verify setup works on a fresh clone

---

**Ready to push!** Follow the steps above to push your VectorDB integration to GitHub.
