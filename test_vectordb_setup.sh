#!/bin/bash

# VectorDB Setup Test Script
# Verifies all components are correctly configured

echo "🔍 VectorDB Integration Setup Test"
echo "=================================="
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SUCCESS=0
WARNINGS=0
FAILURES=0

# Test 1: Qdrant
echo "1️⃣ Testing Qdrant..."
if docker ps | grep -q qdrant; then
    echo -e "${GREEN}✅ Qdrant is running${NC}"
    ((SUCCESS++))
else
    echo -e "${RED}❌ Qdrant is NOT running${NC}"
    echo "   Fix: cd server/vector_memory && docker compose up -d"
    ((FAILURES++))
fi

# Test 2: Python Environment
echo ""
echo "2️⃣ Testing Python Environment..."
if [ -d "server/vector_memory/.venv" ]; then
    echo -e "${GREEN}✅ Virtual environment exists${NC}"
    ((SUCCESS++))
else
    echo -e "${RED}❌ Virtual environment NOT found${NC}"
    echo "   Fix: cd server/vector_memory && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
    ((FAILURES++))
fi

# Test 3: Vector Server
echo ""
echo "3️⃣ Testing Vector Server..."
if curl -s http://127.0.0.1:8787/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Vector server is running${NC}"
    
    # Check binding
    if ps aux | grep "uvicorn main:app" | grep -v grep | grep -q "0.0.0.0"; then
        echo -e "${GREEN}   ✅ Server bound to 0.0.0.0 (network-accessible)${NC}"
        ((SUCCESS++))
    else
        echo -e "${YELLOW}   ⚠️ Server bound to 127.0.0.1 (localhost only)${NC}"
        echo "   Fix: ./restart_vector_server.sh"
        ((WARNINGS++))
    fi
else
    echo -e "${RED}❌ Vector server is NOT running${NC}"
    echo "   Fix: ./restart_vector_server.sh"
    ((FAILURES++))
fi

# Test 4: OPENAI_API_KEY
echo ""
echo "4️⃣ Testing OpenAI API Key..."
if [ -n "$OPENAI_API_KEY" ]; then
    echo -e "${GREEN}✅ OPENAI_API_KEY is set${NC}"
    ((SUCCESS++))
else
    echo -e "${YELLOW}⚠️ OPENAI_API_KEY is NOT set${NC}"
    echo "   Fix: export OPENAI_API_KEY='your-key-here'"
    ((WARNINGS++))
fi

# Test 5: Network IP
echo ""
echo "5️⃣ Testing Network Configuration..."
LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
if [ -n "$LOCAL_IP" ]; then
    echo -e "${GREEN}✅ Network IP detected: $LOCAL_IP${NC}"
    echo "   📝 Use this in Lens Studio: ws://$LOCAL_IP:8787/ws"
    ((SUCCESS++))
else
    echo -e "${RED}❌ Could not detect network IP${NC}"
    echo "   Check: Are you connected to WiFi?"
    ((FAILURES++))
fi

# Test 6: Server Network Accessibility
echo ""
echo "6️⃣ Testing Server Network Accessibility..."
if [ -n "$LOCAL_IP" ]; then
    if curl -s --max-time 2 "http://$LOCAL_IP:8787/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Server is accessible on network IP${NC}"
        ((SUCCESS++))
    else
        echo -e "${RED}❌ Server is NOT accessible on network IP${NC}"
        echo "   Fix: Restart server with 0.0.0.0 binding"
        echo "   Run: ./restart_vector_server.sh"
        ((FAILURES++))
    fi
fi

# Test 7: Qdrant Health
echo ""
echo "7️⃣ Testing Qdrant Health..."
if curl -s http://127.0.0.1:6333/healthz > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Qdrant is healthy${NC}"
    ((SUCCESS++))
else
    echo -e "${YELLOW}⚠️ Qdrant health check failed${NC}"
    echo "   Note: Qdrant might still be starting"
    ((WARNINGS++))
fi

# Test 8: Scene File
echo ""
echo "8️⃣ Testing Scene Configuration..."
if grep -q "VectorIngestController" Assets/Scene.scene 2>/dev/null; then
    echo -e "${GREEN}✅ VectorIngestController found in Scene.scene${NC}"
    ((SUCCESS++))
else
    echo -e "${RED}❌ VectorIngestController NOT found in Scene.scene${NC}"
    echo "   Fix: Open Lens Studio and verify component is added"
    ((FAILURES++))
fi

# Summary
echo ""
echo "=================================="
echo "📊 Test Summary"
echo "=================================="
echo -e "${GREEN}✅ Passed: $SUCCESS${NC}"
if [ $WARNINGS -gt 0 ]; then
    echo -e "${YELLOW}⚠️ Warnings: $WARNINGS${NC}"
fi
if [ $FAILURES -gt 0 ]; then
    echo -e "${RED}❌ Failed: $FAILURES${NC}"
fi
echo ""

# Overall Status
if [ $FAILURES -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}🎉 ALL TESTS PASSED! Ready to deploy to Spectacles.${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Open Lens Studio"
    echo "2. Add InternetModule asset (see INTERNET_MODULE_GUIDE.md)"
    echo "3. Update remoteWsUrl to: ws://$LOCAL_IP:8787/ws"
    echo "4. Test in Preview mode first"
    echo "5. Deploy to Spectacles"
    exit 0
elif [ $FAILURES -eq 0 ]; then
    echo -e "${YELLOW}⚠️ SETUP INCOMPLETE - Fix warnings above${NC}"
    exit 1
else
    echo -e "${RED}❌ SETUP FAILED - Fix errors above before proceeding${NC}"
    exit 2
fi
