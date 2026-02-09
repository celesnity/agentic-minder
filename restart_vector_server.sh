#!/bin/bash

# VectorDB Server Restart Script for Spectacles
# This script stops the existing server and restarts it with network-accessible binding

echo "🔍 Checking for existing uvicorn processes..."
PIDS=$(ps aux | grep "uvicorn main:app" | grep -v grep | awk '{print $2}')

if [ -n "$PIDS" ]; then
    echo "⏹️ Stopping existing server (PID: $PIDS)..."
    echo "$PIDS" | xargs kill
    sleep 2
    echo "✅ Server stopped"
else
    echo "ℹ️ No existing server found"
fi

echo ""
echo "🌐 Finding your network IP..."
LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)

if [ -z "$LOCAL_IP" ]; then
    echo "❌ Could not find network IP address!"
    echo "Please check your network connection"
    exit 1
fi

echo "✅ Your local IP: $LOCAL_IP"
echo ""
echo "📝 Update Lens Studio Scene with this WebSocket URL:"
echo "   ws://$LOCAL_IP:8787/ws"
echo ""

cd "$(dirname "$0")/server/vector_memory"

if [ ! -d ".venv" ]; then
    echo "❌ Virtual environment not found!"
    echo "Please run: python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
    exit 1
fi

echo "🚀 Starting server on 0.0.0.0:8787 (network-accessible mode)..."
echo "   Server will be accessible at: ws://$LOCAL_IP:8787/ws"
echo ""
echo "ℹ️  Using LOCAL embeddings (sentence-transformers) - NO API KEY NEEDED!"
echo "   Model: all-mpnet-base-v2 (768 dimensions)"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

source .venv/bin/activate
uvicorn main:app --reload --host 0.0.0.0 --port 8787
