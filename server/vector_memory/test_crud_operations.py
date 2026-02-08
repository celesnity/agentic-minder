#!/usr/bin/env python3
"""
VectorDB CRUD Operations Test Script

This script demonstrates and tests the new DELETE and LIST operations
for the VectorDB server.

Usage:
    python test_crud_operations.py
"""

import requests
import json
from typing import List, Dict, Any

# Server configuration
BASE_URL = "http://localhost:8787"

def print_section(title: str):
    """Print a section header"""
    print(f"\n{'='*60}")
    print(f"  {title}")
    print('='*60)

def ingest_sample_data() -> List[str]:
    """Ingest sample chunks for testing"""
    print_section("📥 INGESTING SAMPLE DATA")
    
    sample_chunks = [
        {"chunk_id": "test_chunk_1", "text": "Machine learning is a subset of artificial intelligence."},
        {"chunk_id": "test_chunk_2", "text": "Deep learning uses neural networks with multiple layers."},
        {"chunk_id": "test_chunk_3", "text": "Natural language processing helps computers understand human language."},
        {"chunk_id": "test_chunk_4", "text": "Computer vision enables machines to interpret visual information."},
        {"chunk_id": "test_chunk_5", "text": "Reinforcement learning trains agents through rewards and penalties."},
    ]
    
    chunk_ids = []
    for chunk in sample_chunks:
        try:
            response = requests.post(f"{BASE_URL}/ingest", json=chunk)
            if response.status_code == 200:
                chunk_ids.append(chunk["chunk_id"])
                print(f"✅ Ingested: {chunk['chunk_id'][:30]}... ({len(chunk['text'])} chars)")
            else:
                print(f"❌ Failed to ingest {chunk['chunk_id']}: {response.text}")
        except Exception as e:
            print(f"❌ Error ingesting {chunk['chunk_id']}: {e}")
    
    print(f"\n✅ Successfully ingested {len(chunk_ids)} chunks")
    return chunk_ids

def test_count():
    """Test the COUNT operation"""
    print_section("🔢 TESTING COUNT OPERATION")
    
    try:
        response = requests.get(f"{BASE_URL}/count")
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Collection: {data['collection']}")
            print(f"✅ Total chunks: {data['count']}")
            return data['count']
        else:
            print(f"❌ Count failed: {response.text}")
            return 0
    except Exception as e:
        print(f"❌ Error getting count: {e}")
        return 0

def test_list(limit: int = 10, offset: int = 0):
    """Test the LIST operation"""
    print_section(f"📋 TESTING LIST OPERATION (limit={limit}, offset={offset})")
    
    try:
        response = requests.get(f"{BASE_URL}/list", params={"limit": limit, "offset": offset})
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Retrieved {len(data['chunks'])} chunks")
            print(f"✅ Total in collection: {data['total_count']}")
            print(f"✅ Has more: {data['has_more']}")
            
            print("\n📄 Chunks:")
            for i, chunk in enumerate(data['chunks'], 1):
                print(f"\n  [{i}] Chunk ID: {chunk['chunk_id']}")
                print(f"      Point ID: {chunk['point_id']}")
                print(f"      Created: {chunk['created_at']}")
                print(f"      Preview: {chunk['text_preview'][:80]}...")
            
            return data['chunks']
        else:
            print(f"❌ List failed: {response.text}")
            return []
    except Exception as e:
        print(f"❌ Error listing chunks: {e}")
        return []

def test_search(query: str, top_k: int = 3):
    """Test the SEARCH operation"""
    print_section(f"🔍 TESTING SEARCH OPERATION (query='{query}')")
    
    try:
        response = requests.post(f"{BASE_URL}/search", json={"query": query, "top_k": top_k})
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Found {len(data['matches'])} matches")
            
            print("\n🎯 Search Results:")
            for i, match in enumerate(data['matches'], 1):
                print(f"\n  [{i}] Score: {match['score']:.4f}")
                print(f"      Text: {match['text'][:100]}...")
            
            return data['matches']
        else:
            print(f"❌ Search failed: {response.text}")
            return []
    except Exception as e:
        print(f"❌ Error searching: {e}")
        return []

def test_delete(chunk_ids: List[str]):
    """Test the DELETE operation"""
    print_section(f"🗑️ TESTING DELETE OPERATION ({len(chunk_ids)} chunks)")
    
    print(f"Deleting chunks: {', '.join(chunk_ids)}")
    
    try:
        response = requests.post(f"{BASE_URL}/delete", json={"chunk_ids": chunk_ids})
        if response.status_code == 200:
            data = response.json()
            print(f"✅ Successfully deleted {data['deleted_count']} chunks")
            return data['deleted_count']
        else:
            print(f"❌ Delete failed: {response.text}")
            return 0
    except Exception as e:
        print(f"❌ Error deleting chunks: {e}")
        return 0

def test_reset():
    """Test the RESET operation"""
    print_section("🔄 TESTING RESET OPERATION")
    
    try:
        response = requests.post(f"{BASE_URL}/reset")
        if response.status_code == 200:
            print("✅ Collection reset successfully")
            return True
        else:
            print(f"❌ Reset failed: {response.text}")
            return False
    except Exception as e:
        print(f"❌ Error resetting collection: {e}")
        return False

def main():
    """Run all CRUD operation tests"""
    print("\n" + "="*60)
    print("  🧪 VectorDB CRUD Operations Test Suite")
    print("="*60)
    print(f"  Server: {BASE_URL}")
    print("="*60)
    
    # Step 1: Reset collection
    test_reset()
    
    # Step 2: Check initial count (should be 0)
    initial_count = test_count()
    assert initial_count == 0, f"Expected 0 chunks, got {initial_count}"
    
    # Step 3: Ingest sample data
    chunk_ids = ingest_sample_data()
    
    # Step 4: Check count after ingestion
    count_after_ingest = test_count()
    assert count_after_ingest == len(chunk_ids), f"Expected {len(chunk_ids)} chunks, got {count_after_ingest}"
    
    # Step 5: List all chunks
    chunks = test_list(limit=10, offset=0)
    
    # Step 6: Test semantic search
    test_search("tell me about neural networks", top_k=3)
    test_search("how do computers understand language", top_k=2)
    
    # Step 7: List with pagination
    print_section("📋 TESTING PAGINATION")
    page1 = test_list(limit=2, offset=0)
    page2 = test_list(limit=2, offset=2)
    print(f"\n✅ Page 1: {len(page1)} chunks")
    print(f"✅ Page 2: {len(page2)} chunks")
    
    # Step 8: Delete some chunks
    chunks_to_delete = chunk_ids[:2]  # Delete first 2 chunks
    deleted_count = test_delete(chunks_to_delete)
    assert deleted_count == len(chunks_to_delete), f"Expected {len(chunks_to_delete)} deleted, got {deleted_count}"
    
    # Step 9: Verify deletion
    count_after_delete = test_count()
    expected_count = len(chunk_ids) - len(chunks_to_delete)
    assert count_after_delete == expected_count, f"Expected {expected_count} chunks, got {count_after_delete}"
    
    # Step 10: List remaining chunks
    remaining_chunks = test_list()
    print(f"\n✅ Remaining chunks after deletion: {len(remaining_chunks)}")
    
    # Final summary
    print_section("📊 TEST SUMMARY")
    print(f"✅ Initial count: {initial_count}")
    print(f"✅ After ingest: {count_after_ingest}")
    print(f"✅ After delete: {count_after_delete}")
    print(f"✅ Final remaining: {len(remaining_chunks)}")
    print("\n🎉 All CRUD operations working correctly!\n")

if __name__ == "__main__":
    main()
