import os
import time
import json
import logging
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from qdrant_client import QdrantClient
from qdrant_client.http import models as qmodels
from sentence_transformers import SentenceTransformer

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

QDRANT_URL = os.getenv("QDRANT_URL", "http://127.0.0.1:6333")

COLLECTION = os.getenv("VECTOR_COLLECTION", "latest_session")
EMBED_MODEL = os.getenv("EMBED_MODEL", "all-mpnet-base-v2")  # Local model
VECTOR_SIZE = 768  # all-mpnet-base-v2 outputs 768 dimensions

# Initialize Sentence Transformers model
logger.info("🔄 Loading Sentence Transformers model: %s", EMBED_MODEL)
embedding_model = SentenceTransformer(EMBED_MODEL)
logger.info("✅ Model loaded successfully! Vector size: %d", VECTOR_SIZE)


app = FastAPI(title="Local Vector Memory Server", version="0.1.0")

logger.info("🚀 FastAPI server initialized")
logger.info("📊 Configuration:")
logger.info("   - Qdrant URL: %s", QDRANT_URL)
logger.info("   - Collection: %s", COLLECTION)
logger.info("   - Embedding Model: %s (LOCAL - FREE)", EMBED_MODEL)
logger.info("   - Vector Dimensions: %d", VECTOR_SIZE)


def _client() -> QdrantClient:
    return QdrantClient(url=QDRANT_URL)


def chunk_id_to_point_id(chunk_id: str) -> int:
    """Convert chunk ID string to a valid Qdrant point ID (unsigned integer)"""
    import hashlib
    # Create a hash of the chunk_id and convert to integer
    hash_object = hashlib.md5(chunk_id.encode())
    # Take first 8 bytes and convert to unsigned integer
    point_id = int.from_bytes(hash_object.digest()[:8], byteorder='big')
    logger.debug("📍 Converted chunk_id '%s' to point_id %d", chunk_id, point_id)
    return point_id


def embed_text(text: str) -> List[float]:
    """Generate embeddings using local Sentence Transformers model"""
    t = text.strip()
    if not t:
        logger.warning("⚠️ Empty text provided for embedding")
        return [0.0] * VECTOR_SIZE
    
    logger.info("🔄 Generating embedding for text (%d chars): '%s...'", len(t), t[:50])
    
    try:
        # Generate embedding using local model (FREE!)
        vec = embedding_model.encode(t, show_progress_bar=False)
        vec_list = vec.tolist()
        
        logger.info("✅ Embedding generated successfully! Vector size: %d", len(vec_list))
        return vec_list
    except Exception as e:
        logger.error("❌ Embedding generation failed: %s", str(e))
        raise


def ensure_collection() -> None:
    """Ensure the Qdrant collection exists"""
    logger.info("🔍 Checking if collection '%s' exists...", COLLECTION)
    qc = _client()
    existing = [c.name for c in qc.get_collections().collections]
    
    if COLLECTION in existing:
        logger.info("✅ Collection '%s' already exists", COLLECTION)
        return
    
    logger.info("📦 Creating new collection '%s' with vector size %d", COLLECTION, VECTOR_SIZE)
    qc.create_collection(
        collection_name=COLLECTION,
        vectors_config=qmodels.VectorParams(size=VECTOR_SIZE, distance=qmodels.Distance.COSINE),
    )
    logger.info("✅ Collection '%s' created successfully!", COLLECTION)


def reset_collection() -> None:
    """Reset the Qdrant collection (delete and recreate)"""
    logger.info("🔄 Resetting collection '%s'...", COLLECTION)
    qc = _client()
    existing = [c.name for c in qc.get_collections().collections]
    
    if COLLECTION in existing:
        logger.info("🗑️ Deleting existing collection '%s'", COLLECTION)
        qc.delete_collection(collection_name=COLLECTION)
    
    logger.info("📦 Creating fresh collection '%s' with vector size %d", COLLECTION, VECTOR_SIZE)
    qc.create_collection(
        collection_name=COLLECTION,
        vectors_config=qmodels.VectorParams(size=VECTOR_SIZE, distance=qmodels.Distance.COSINE),
    )
    logger.info("✅ Collection '%s' reset successfully!", COLLECTION)


class ResetResponse(BaseModel):
    ok: bool = True


class IngestRequest(BaseModel):
    chunk_id: str
    text: str
    created_at: int = Field(default_factory=lambda: int(time.time() * 1000))


class IngestResponse(BaseModel):
    ok: bool = True


class SearchRequest(BaseModel):
    query: str
    top_k: int = 3


class SearchMatch(BaseModel):
    score: float
    text: str
    created_at: Optional[int] = None


class SearchResponse(BaseModel):
    ok: bool = True
    matches: List[SearchMatch]


# DELETE operation models
class DeleteRequest(BaseModel):
    chunk_ids: List[str]


class DeleteResponse(BaseModel):
    ok: bool = True
    deleted_count: int


# LIST operation models
class ChunkInfo(BaseModel):
    chunk_id: str
    point_id: int
    text: str
    created_at: int
    text_preview: str  # First 100 chars


class ListResponse(BaseModel):
    ok: bool = True
    chunks: List[ChunkInfo]
    total_count: int
    has_more: bool


# COUNT operation models
class CountResponse(BaseModel):
    ok: bool = True
    count: int
    collection: str


@app.get("/health")
def health() -> Dict[str, Any]:
    logger.info("💚 Health check requested")
    return {
        "ok": True,
        "qdrant_url": QDRANT_URL,
        "collection": COLLECTION,
        "embed_model": EMBED_MODEL,
        "vector_size": VECTOR_SIZE,
        "embedding_type": "local_free"
    }


@app.post("/session/reset", response_model=ResetResponse)
def http_reset() -> ResetResponse:
    logger.info("🔄 HTTP: Session reset requested")
    reset_collection()
    logger.info("✅ HTTP: Session reset completed")
    return ResetResponse(ok=True)


@app.post("/ingest", response_model=IngestResponse)
def http_ingest(req: IngestRequest) -> IngestResponse:
    logger.info("📥 HTTP: Ingest request received")
    logger.info("   - Chunk ID: %s", req.chunk_id)
    logger.info("   - Text length: %d chars", len(req.text))
    logger.info("   - Text preview: '%s...'", req.text[:100])
    
    ensure_collection()
    vec = embed_text(req.text)

    # Convert chunk_id to valid Qdrant point ID (unsigned integer)
    point_id = chunk_id_to_point_id(req.chunk_id)
    logger.info("💾 Storing vector in Qdrant with point_id: %d...", point_id)
    
    qc = _client()
    qc.upsert(
        collection_name=COLLECTION,
        points=[
            qmodels.PointStruct(
                id=point_id,
                vector=vec,
                payload={"text": req.text, "created_at": req.created_at, "chunk_id": req.chunk_id},
            )
        ],
    )
    logger.info("✅ Vector stored successfully in Qdrant!")
    logger.info("📊 Collection '%s' now contains this chunk (ID: %d)", COLLECTION, point_id)
    return IngestResponse(ok=True)


@app.post("/search", response_model=SearchResponse)
def http_search(req: SearchRequest) -> SearchResponse:
    logger.info("🔍 HTTP: Search request received")
    logger.info("   - Query: '%s'", req.query)
    logger.info("   - Top K: %d", req.top_k)
    
    ensure_collection()
    qvec = embed_text(req.query)
    qc = _client()

    logger.info("🔎 Searching Qdrant for similar vectors...")
    hits = qc.search(
        collection_name=COLLECTION,
        query_vector=qvec,
        limit=max(1, min(req.top_k, 10)),
        with_payload=True,
    )

    logger.info("✅ Found %d matches", len(hits))
    matches: List[SearchMatch] = []
    for i, h in enumerate(hits):
        payload = h.payload or {}
        logger.info("   Match #%d: Score=%.4f, Text='%s...'", i+1, h.score, str(payload.get("text", ""))[:50])
        matches.append(
            SearchMatch(
                score=float(h.score),
                text=str(payload.get("text", "")),
                created_at=payload.get("created_at"),
            )
        )
    return SearchResponse(ok=True, matches=matches)


@app.post("/delete", response_model=DeleteResponse)
def http_delete(req: DeleteRequest) -> DeleteResponse:
    """Delete specific chunks by their chunk IDs"""
    logger.info("🗑️ HTTP: Delete request received")
    logger.info("   - Chunk IDs to delete: %s", req.chunk_ids)
    
    if not req.chunk_ids:
        logger.warning("⚠️ No chunk IDs provided for deletion")
        return DeleteResponse(ok=True, deleted_count=0)
    
    ensure_collection()
    
    # Convert chunk_ids to point_ids
    point_ids = [chunk_id_to_point_id(cid) for cid in req.chunk_ids]
    logger.info("📍 Converted to point IDs: %s", point_ids)
    
    qc = _client()
    
    try:
        logger.info("🗑️ Deleting %d points from Qdrant...", len(point_ids))
        qc.delete(
            collection_name=COLLECTION,
            points_selector=qmodels.PointIdsList(points=point_ids),
        )
        logger.info("✅ Successfully deleted %d chunks", len(point_ids))
        return DeleteResponse(ok=True, deleted_count=len(point_ids))
    except Exception as e:
        logger.error("❌ Delete operation failed: %s", str(e))
        raise


@app.get("/list", response_model=ListResponse)
def http_list(limit: int = 100, offset: int = 0) -> ListResponse:
    """List all chunks with pagination"""
    logger.info("📋 HTTP: List request received")
    logger.info("   - Limit: %d, Offset: %d", limit, offset)
    
    ensure_collection()
    qc = _client()
    
    # Get collection info for total count
    collection_info = qc.get_collection(collection_name=COLLECTION)
    total_count = collection_info.points_count
    logger.info("📊 Collection contains %d total points", total_count)
    
    # Scroll through points
    logger.info("🔄 Fetching chunks from Qdrant...")
    points, next_offset = qc.scroll(
        collection_name=COLLECTION,
        limit=limit,
        offset=offset,
        with_payload=True,
        with_vectors=False,  # Don't need vectors for listing
    )
    
    logger.info("✅ Retrieved %d chunks", len(points))
    
    chunks: List[ChunkInfo] = []
    for point in points:
        payload = point.payload or {}
        text = str(payload.get("text", ""))
        chunk_id = str(payload.get("chunk_id", f"unknown_{point.id}"))
        created_at = payload.get("created_at", 0)
        
        chunks.append(ChunkInfo(
            chunk_id=chunk_id,
            point_id=point.id,
            text=text,
            created_at=created_at,
            text_preview=text[:100] if text else "(empty)"
        ))
        logger.debug("   - Chunk: %s (point_id=%d, %d chars)", chunk_id, point.id, len(text))
    
    has_more = (offset + len(points)) < total_count
    logger.info("📊 Returning %d chunks (has_more=%s)", len(chunks), has_more)
    
    return ListResponse(
        ok=True,
        chunks=chunks,
        total_count=total_count,
        has_more=has_more
    )


@app.get("/count", response_model=CountResponse)
def http_count() -> CountResponse:
    """Get total number of chunks in the collection"""
    logger.info("🔢 HTTP: Count request received")
    
    ensure_collection()
    qc = _client()
    
    collection_info = qc.get_collection(collection_name=COLLECTION)
    count = collection_info.points_count
    
    logger.info("✅ Collection '%s' contains %d points", COLLECTION, count)
    return CountResponse(ok=True, count=count, collection=COLLECTION)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    client_address = ws.client
    logger.info("🔌 WebSocket: New connection from %s", client_address)
    await ws.accept()
    logger.info("✅ WebSocket: Connection accepted")
    
    try:
        ensure_collection()
        logger.info("🎧 WebSocket: Listening for messages...")
        
        while True:
            # Handle JSON parsing errors gracefully to prevent connection drops
            try:
                msg = await ws.receive_json()
            except json.JSONDecodeError as e:
                logger.warning("⚠️ WebSocket: JSON decode error - %s", str(e))
                logger.warning("   Skipping malformed message and continuing")
                continue
            except Exception as e:
                logger.error("❌ WebSocket: Error receiving message - %s", str(e))
                break
            
            req_id = msg.get("id")
            op = msg.get("op")
            
            logger.info("📨 WebSocket: Received message")
            logger.info("   - Request ID: %s", req_id)
            logger.info("   - Operation: %s", op)

            try:
                if op == "reset":
                    logger.info("🔄 WebSocket: Processing RESET operation")
                    reset_collection()
                    await ws.send_json({"id": req_id, "ok": True})
                    logger.info("✅ WebSocket: RESET completed, response sent")
                    
                elif op == "ingest":
                    chunk_id = msg.get("chunk_id")
                    text = msg.get("text", "")
                    created_at = int(msg.get("created_at") or int(time.time() * 1000))
                    
                    logger.info("📥 WebSocket: Processing INGEST operation")
                    logger.info("   - Chunk ID: %s", chunk_id)
                    logger.info("   - Text length: %d chars", len(text))
                    logger.info("   - Text preview: '%s...'", text[:100])
                    
                    if not chunk_id:
                        raise ValueError("chunk_id required")
                    
                    # Call the ingest function with detailed logging
                    http_ingest(IngestRequest(chunk_id=chunk_id, text=text, created_at=created_at))
                    
                    await ws.send_json({"id": req_id, "ok": True})
                    logger.info("✅ WebSocket: INGEST completed, response sent")
                    
                elif op == "search":
                    query = msg.get("query", "")
                    top_k = int(msg.get("top_k") or 3)
                    
                    logger.info("🔍 WebSocket: Processing SEARCH operation")
                    logger.info("   - Query: '%s'", query)
                    logger.info("   - Top K: %d", top_k)
                    
                    resp = http_search(SearchRequest(query=query, top_k=top_k))
                    await ws.send_json({"id": req_id, "ok": True, "matches": [m.model_dump() for m in resp.matches]})
                    logger.info("✅ WebSocket: SEARCH completed, response sent with %d matches", len(resp.matches))
                
                elif op == "delete":
                    chunk_ids = msg.get("chunk_ids", [])
                    
                    logger.info("🗑️ WebSocket: Processing DELETE operation")
                    logger.info("   - Chunk IDs: %s", chunk_ids)
                    
                    resp = http_delete(DeleteRequest(chunk_ids=chunk_ids))
                    await ws.send_json({"id": req_id, "ok": True, "deleted_count": resp.deleted_count})
                    logger.info("✅ WebSocket: DELETE completed, deleted %d chunks", resp.deleted_count)
                
                elif op == "list":
                    limit = int(msg.get("limit") or 100)
                    offset = int(msg.get("offset") or 0)
                    
                    logger.info("📋 WebSocket: Processing LIST operation")
                    logger.info("   - Limit: %d, Offset: %d", limit, offset)
                    
                    resp = http_list(limit=limit, offset=offset)
                    await ws.send_json({
                        "id": req_id, 
                        "ok": True, 
                        "chunks": [c.model_dump() for c in resp.chunks],
                        "total_count": resp.total_count,
                        "has_more": resp.has_more
                    })
                    logger.info("✅ WebSocket: LIST completed, returned %d chunks", len(resp.chunks))
                
                elif op == "count":
                    logger.info("🔢 WebSocket: Processing COUNT operation")
                    
                    resp = http_count()
                    await ws.send_json({"id": req_id, "ok": True, "count": resp.count, "collection": resp.collection})
                    logger.info("✅ WebSocket: COUNT completed, collection has %d points", resp.count)
                    
                else:
                    logger.error("❌ WebSocket: Unknown operation: %s", op)
                    raise ValueError(f"unknown op: {op}")
                    
            except Exception as e:
                logger.error("❌ WebSocket: Operation failed: %s", str(e))
                await ws.send_json({"id": req_id, "ok": False, "error": str(e)})
                
    except WebSocketDisconnect:
        logger.info("🔌 WebSocket: Client disconnected from %s", client_address)
        return

