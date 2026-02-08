#!/usr/bin/env python3
"""
Real-World VectorDB CRUD Testing Script

This script tests CRUD operations on ACTUAL data collected by your
Spectacles/Lens Studio application.

Usage:
    python test_real_data.py
"""

import requests
import json
import sys
from typing import List, Dict, Any
from datetime import datetime

# Server configuration
BASE_URL = "http://localhost:8787"

class Colors:
    """ANSI color codes for pretty output"""
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    END = '\033[0m'
    BOLD = '\033[1m'

def print_header(text: str):
    """Print section header"""
    print(f"\n{Colors.BOLD}{Colors.CYAN}{'='*70}{Colors.END}")
    print(f"{Colors.BOLD}{Colors.CYAN}  {text}{Colors.END}")
    print(f"{Colors.BOLD}{Colors.CYAN}{'='*70}{Colors.END}\n")

def print_success(text: str):
    """Print success message"""
    print(f"{Colors.GREEN}✅ {text}{Colors.END}")

def print_info(text: str):
    """Print info message"""
    print(f"{Colors.BLUE}ℹ️  {text}{Colors.END}")

def print_warning(text: str):
    """Print warning message"""
    print(f"{Colors.YELLOW}⚠️  {text}{Colors.END}")

def print_error(text: str):
    """Print error message"""
    print(f"{Colors.RED}❌ {text}{Colors.END}")

def check_server_health() -> bool:
    """Check if VectorDB server is running"""
    print_header("🏥 SERVER HEALTH CHECK")
    
    try:
        response = requests.get(f"{BASE_URL}/health", timeout=3)
        if response.status_code == 200:
            data = response.json()
            print_success(f"Server is running!")
            print_info(f"   - Embedding model: {data.get('embedding_model', 'unknown')}")
            print_info(f"   - Vector size: {data.get('vector_size', 'unknown')}")
            print_info(f"   - Embedding type: {data.get('embedding_type', 'unknown')}")
            return True
        else:
            print_error(f"Server returned status {response.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        print_error("Cannot connect to server!")
        print_info(f"   Make sure server is running at {BASE_URL}")
        print_info("   Run: ./setup_local_embeddings.sh")
        return False
    except Exception as e:
        print_error(f"Health check failed: {e}")
        return False

def get_collection_stats() -> Dict[str, Any]:
    """Get current collection statistics"""
    print_header("📊 COLLECTION STATISTICS")
    
    try:
        response = requests.get(f"{BASE_URL}/count")
        if response.status_code == 200:
            data = response.json()
            count = data['count']
            collection = data['collection']
            
            print_success(f"Collection: {Colors.BOLD}{collection}{Colors.END}")
            print_success(f"Total chunks: {Colors.BOLD}{count}{Colors.END}")
            
            return {"count": count, "collection": collection}
        else:
            print_error(f"Failed to get stats: {response.text}")
            return {"count": 0, "collection": "unknown"}
    except Exception as e:
        print_error(f"Error getting stats: {e}")
        return {"count": 0, "collection": "unknown"}

def list_all_chunks(limit: int = 50) -> List[Dict[str, Any]]:
    """List all chunks in the collection"""
    print_header(f"📋 LISTING REAL DATA (showing first {limit})")
    
    try:
        response = requests.get(f"{BASE_URL}/list", params={"limit": limit, "offset": 0})
        if response.status_code == 200:
            data = response.json()
            chunks = data['chunks']
            total = data['total_count']
            has_more = data['has_more']
            
            print_success(f"Retrieved {len(chunks)} chunks (Total in DB: {total})")
            
            if len(chunks) == 0:
                print_warning("No data found in VectorDB!")
                print_info("   Start recording in Lens Studio to collect data")
                return []
            
            print(f"\n{Colors.BOLD}Chunks in your VectorDB:{Colors.END}\n")
            
            for i, chunk in enumerate(chunks, 1):
                chunk_id = chunk['chunk_id']
                text = chunk['text']
                created_at = chunk['created_at']
                text_preview = chunk['text_preview']
                
                # Convert timestamp to readable format
                try:
                    dt = datetime.fromtimestamp(created_at / 1000)
                    time_str = dt.strftime("%Y-%m-%d %H:%M:%S")
                except:
                    time_str = "unknown"
                
                print(f"{Colors.BOLD}[{i}] {chunk_id}{Colors.END}")
                print(f"    Time: {time_str}")
                print(f"    Length: {len(text)} chars")
                print(f"    Preview: {Colors.CYAN}{text_preview[:80]}...{Colors.END}")
                print()
            
            if has_more:
                print_info(f"... and {total - len(chunks)} more chunks in the database")
            
            return chunks
        else:
            print_error(f"Failed to list chunks: {response.text}")
            return []
    except Exception as e:
        print_error(f"Error listing chunks: {e}")
        return []

def search_real_data(query: str, top_k: int = 5):
    """Test semantic search on real data"""
    print_header(f"🔍 SEMANTIC SEARCH: '{query}'")
    
    try:
        response = requests.post(
            f"{BASE_URL}/search",
            json={"query": query, "top_k": top_k}
        )
        
        if response.status_code == 200:
            data = response.json()
            matches = data['matches']
            
            if len(matches) == 0:
                print_warning("No matches found!")
                print_info("   Try a different search query or collect more data")
                return []
            
            print_success(f"Found {len(matches)} relevant chunks:\n")
            
            for i, match in enumerate(matches, 1):
                score = match['score']
                text = match['text']
                
                # Color code by relevance
                if score > 0.7:
                    score_color = Colors.GREEN
                elif score > 0.5:
                    score_color = Colors.YELLOW
                else:
                    score_color = Colors.RED
                
                print(f"{Colors.BOLD}[{i}] Relevance: {score_color}{score:.4f}{Colors.END}")
                print(f"    {Colors.CYAN}{text[:150]}...{Colors.END}")
                print()
            
            return matches
        else:
            print_error(f"Search failed: {response.text}")
            return []
    except Exception as e:
        print_error(f"Error searching: {e}")
        return []

def delete_chunks_interactive(chunks: List[Dict[str, Any]]):
    """Interactive chunk deletion"""
    print_header("🗑️ DELETE CHUNKS (INTERACTIVE)")
    
    if not chunks:
        print_warning("No chunks to delete!")
        return
    
    print(f"You have {len(chunks)} chunks in your database.\n")
    print(f"{Colors.BOLD}Available options:{Colors.END}")
    print("  1. Delete specific chunks by number")
    print("  2. Delete oldest chunks")
    print("  3. Delete all chunks (RESET)")
    print("  4. Skip deletion")
    
    choice = input(f"\n{Colors.BOLD}Enter choice (1-4): {Colors.END}").strip()
    
    if choice == "1":
        # Delete specific chunks
        print(f"\n{Colors.BOLD}Chunks:{Colors.END}")
        for i, chunk in enumerate(chunks[:20], 1):  # Show first 20
            print(f"  [{i}] {chunk['text_preview'][:60]}...")
        
        indices = input(f"\n{Colors.BOLD}Enter chunk numbers to delete (e.g., 1,3,5): {Colors.END}").strip()
        
        try:
            selected_indices = [int(x.strip()) - 1 for x in indices.split(",")]
            chunk_ids_to_delete = [chunks[i]['chunk_id'] for i in selected_indices if 0 <= i < len(chunks)]
            
            if chunk_ids_to_delete:
                confirm = input(f"\n{Colors.YELLOW}Delete {len(chunk_ids_to_delete)} chunks? (yes/no): {Colors.END}").strip().lower()
                if confirm == "yes":
                    deleted_count = delete_chunks(chunk_ids_to_delete)
                    print_success(f"Deleted {deleted_count} chunks!")
                else:
                    print_info("Deletion cancelled")
            else:
                print_warning("No valid chunks selected")
        except Exception as e:
            print_error(f"Invalid input: {e}")
    
    elif choice == "2":
        # Delete oldest chunks
        num = input(f"\n{Colors.BOLD}How many oldest chunks to delete? {Colors.END}").strip()
        try:
            num = int(num)
            sorted_chunks = sorted(chunks, key=lambda c: c['created_at'])
            chunk_ids_to_delete = [c['chunk_id'] for c in sorted_chunks[:num]]
            
            confirm = input(f"\n{Colors.YELLOW}Delete {len(chunk_ids_to_delete)} oldest chunks? (yes/no): {Colors.END}").strip().lower()
            if confirm == "yes":
                deleted_count = delete_chunks(chunk_ids_to_delete)
                print_success(f"Deleted {deleted_count} chunks!")
            else:
                print_info("Deletion cancelled")
        except Exception as e:
            print_error(f"Invalid input: {e}")
    
    elif choice == "3":
        # Reset all
        confirm = input(f"\n{Colors.RED}{Colors.BOLD}⚠️  DELETE ALL CHUNKS? This cannot be undone! (yes/no): {Colors.END}").strip().lower()
        if confirm == "yes":
            reset_collection()
        else:
            print_info("Reset cancelled")
    
    else:
        print_info("Skipping deletion")

def delete_chunks(chunk_ids: List[str]) -> int:
    """Delete specific chunks"""
    try:
        response = requests.post(
            f"{BASE_URL}/delete",
            json={"chunk_ids": chunk_ids}
        )
        
        if response.status_code == 200:
            data = response.json()
            return data['deleted_count']
        else:
            print_error(f"Delete failed: {response.text}")
            return 0
    except Exception as e:
        print_error(f"Error deleting chunks: {e}")
        return 0

def reset_collection():
    """Reset entire collection"""
    try:
        response = requests.post(f"{BASE_URL}/reset")
        if response.status_code == 200:
            print_success("Collection reset successfully!")
            print_info("All chunks have been deleted")
        else:
            print_error(f"Reset failed: {response.text}")
    except Exception as e:
        print_error(f"Error resetting collection: {e}")

def export_chunks_to_json(chunks: List[Dict[str, Any]]):
    """Export chunks to JSON file"""
    print_header("💾 EXPORT DATA")
    
    if not chunks:
        print_warning("No chunks to export!")
        return
    
    filename = f"vectordb_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    
    try:
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(chunks, f, indent=2, ensure_ascii=False)
        
        print_success(f"Exported {len(chunks)} chunks to: {Colors.BOLD}{filename}{Colors.END}")
        print_info(f"   File size: {len(json.dumps(chunks)) / 1024:.2f} KB")
    except Exception as e:
        print_error(f"Export failed: {e}")

def analyze_data_quality(chunks: List[Dict[str, Any]]):
    """Analyze the quality of collected data"""
    print_header("📈 DATA QUALITY ANALYSIS")
    
    if not chunks:
        print_warning("No data to analyze!")
        return
    
    total = len(chunks)
    total_chars = sum(len(c['text']) for c in chunks)
    avg_chars = total_chars / total if total > 0 else 0
    
    print_success(f"Total chunks: {total}")
    print_success(f"Total characters: {total_chars:,}")
    print_success(f"Average chunk size: {avg_chars:.0f} chars")
    
    # Size distribution
    small = len([c for c in chunks if len(c['text']) < 200])
    medium = len([c for c in chunks if 200 <= len(c['text']) < 500])
    large = len([c for c in chunks if len(c['text']) >= 500])
    
    print(f"\n{Colors.BOLD}Size Distribution:{Colors.END}")
    print(f"  Small (<200 chars): {small} ({small/total*100:.1f}%)")
    print(f"  Medium (200-500): {medium} ({medium/total*100:.1f}%)")
    print(f"  Large (>500): {large} ({large/total*100:.1f}%)")
    
    # Time span
    if chunks:
        times = [c['created_at'] for c in chunks]
        first_time = datetime.fromtimestamp(min(times) / 1000)
        last_time = datetime.fromtimestamp(max(times) / 1000)
        duration = (max(times) - min(times)) / 1000  # seconds
        
        print(f"\n{Colors.BOLD}Time Range:{Colors.END}")
        print(f"  First chunk: {first_time.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"  Last chunk: {last_time.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"  Duration: {duration / 60:.1f} minutes")

def main():
    """Main testing flow"""
    print(f"\n{Colors.BOLD}{Colors.HEADER}")
    print("╔═══════════════════════════════════════════════════════════════════╗")
    print("║  🧪 VectorDB CRUD Testing - Real-World Data Edition              ║")
    print("║  This script tests operations on YOUR actual collected data      ║")
    print("╚═══════════════════════════════════════════════════════════════════╝")
    print(f"{Colors.END}\n")
    
    print_info(f"Server: {BASE_URL}")
    print_info("Press Ctrl+C at any time to exit\n")
    
    # Step 1: Check server health
    if not check_server_health():
        sys.exit(1)
    
    # Step 2: Get statistics
    stats = get_collection_stats()
    
    if stats['count'] == 0:
        print_warning("\n⚠️  Your VectorDB is empty!")
        print_info("To collect data:")
        print_info("  1. Open Lens Studio")
        print_info("  2. Start recording with Spectacles")
        print_info("  3. Speak for 30+ seconds")
        print_info("  4. Run this script again\n")
        sys.exit(0)
    
    # Step 3: List all chunks
    chunks = list_all_chunks(limit=50)
    
    # Step 4: Analyze data quality
    analyze_data_quality(chunks)
    
    # Step 5: Test semantic search
    print_header("🔍 TEST SEMANTIC SEARCH")
    print_info("Now let's test searching your actual data!\n")
    
    # Try some example searches
    example_queries = [
        "what was discussed about landing",
        "felt package",
        "reading"
    ]
    
    print(f"{Colors.BOLD}Example searches:{Colors.END}")
    for i, q in enumerate(example_queries, 1):
        print(f"  {i}. {q}")
    
    custom_query = input(f"\n{Colors.BOLD}Enter custom search query (or press Enter to use example 1): {Colors.END}").strip()
    
    if not custom_query:
        custom_query = example_queries[0]
    
    search_real_data(custom_query, top_k=5)
    
    # Step 6: Export option
    print_header("💾 EXPORT OPTIONS")
    export_choice = input(f"{Colors.BOLD}Export data to JSON? (yes/no): {Colors.END}").strip().lower()
    if export_choice == "yes":
        export_chunks_to_json(chunks)
    
    # Step 7: Delete option
    delete_choice = input(f"\n{Colors.BOLD}Manage/delete chunks? (yes/no): {Colors.END}").strip().lower()
    if delete_choice == "yes":
        delete_chunks_interactive(chunks)
        
        # Show final stats
        print_header("📊 FINAL STATISTICS")
        get_collection_stats()
    
    print(f"\n{Colors.GREEN}{Colors.BOLD}✅ Testing complete!{Colors.END}\n")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n\n{Colors.YELLOW}⚠️  Interrupted by user{Colors.END}\n")
        sys.exit(0)
    except Exception as e:
        print(f"\n{Colors.RED}❌ Error: {e}{Colors.END}\n")
        sys.exit(1)
