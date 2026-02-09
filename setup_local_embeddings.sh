#!/bin/bash

# Install Sentence Transformers and restart server
# This script updates dependencies and restarts with local embeddings

echo "🔧 VectorDB Server - Sentence Transformers Setup"
echo "================================================"
echo ""

cd "$(dirname "$0")/server/vector_memory"

# Check if venv exists
if [ ! -d ".venv" ]; then
    echo "❌ Virtual environment not found!"
    echo "Creating new virtual environment..."
    python3 -m venv .venv
fi

# Activate venv
echo "🔄 Activating virtual environment..."
source .venv/bin/activate

# Stop existing server
echo ""
echo "⏹️ Stopping existing server..."
PIDS=$(ps aux | grep "uvicorn main:app" | grep -v grep | awk '{print $2}')
if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill
    sleep 2
    echo "✅ Server stopped"
else
    echo "ℹ️ No existing server found"
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies (this may take 2-3 minutes)..."
echo "   - sentence-transformers (local embeddings - FREE!)"
echo "   - torch (required for embeddings)"
echo ""

pip install -r requirements.txt

echo ""
echo "🔄 Downloading embedding model: all-mpnet-base-v2..."
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-mpnet-base-v2')"

echo ""
echo "✅ Installation complete!"
echo ""

# Get network IP
echo "🌐 Finding your network IP..."
LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)

if [ -z "$LOCAL_IP" ]; then
    echo "❌ Could not find network IP address!"
    LOCAL_IP="127.0.0.1"
fi

echo "✅ Your local IP: $LOCAL_IP"
echo ""
echo "📝 Use this WebSocket URL in Lens Studio:"
echo "   ws://$LOCAL_IP:8787/ws"
echo ""

# Reset Qdrant collection (new vector size)
echo "🔄 Resetting Qdrant collection for new vector size (768 dimensions)..."
curl -X DELETE http://localhost:6333/collections/latest_session 2>/dev/null
echo ""

echo "🚀 Starting server with LOCAL embeddings (FREE)..."
echo "   - Model: all-mpnet-base-v2"
echo "   - Vector size: 768 dimensions"
echo "   - No OpenAI API key needed!"
echo ""
echo "📊 Watch the logs below to see embeddings being generated..."
echo "================================================"
echo ""

# Start server
uvicorn main:app --reload --host 0.0.0.0 --port 8787
