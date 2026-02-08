/**
 * RemoteVectorMemoryClient - WebSocket client for a local vector memory service.
 *
 * Intended for Lens Studio Preview internal demos (non-publish):
 * - Connects to a ws:// server on the developer machine (default: ws://127.0.0.1:8787/ws)
 * - Supports: reset session, ingest transcript chunks, semantic search
 */
export class RemoteVectorMemoryClient {
  private internetModule: InternetModule
  private wsUrl: string
  private enableDebugLogging: boolean

  private socket: WebSocket | null = null
  private connectPromise: Promise<void> | null = null

  private requestCounter: number = 0
  private pending: Map<string, {resolve: (v: any) => void; reject: (e: any) => void}> = new Map()

  constructor(internetModule: InternetModule, wsUrl: string, options?: {enableDebugLogging?: boolean}) {
    this.internetModule = internetModule
    this.wsUrl = wsUrl
    this.enableDebugLogging = options?.enableDebugLogging ?? false
  }

  public async resetLatestSession(): Promise<void> {
    print("RemoteVectorMemoryClient: 🔄 Requesting session reset...")
    await this.ensureConnected()
    await this.sendRequest("reset", {})
    print("RemoteVectorMemoryClient: ✅ Session reset completed")
  }

  public async ingestChunk(text: string, chunkId?: string, createdAt?: number): Promise<void> {
    const t = (text || "").trim()
    if (!t) {
      print("RemoteVectorMemoryClient: ⚠️ Empty text, skipping ingest")
      return
    }
    
    const cid = chunkId || `chunk_${Date.now()}_${Math.floor(Math.random() * 10000)}`
    const cat = createdAt || Date.now()
    
    print(`RemoteVectorMemoryClient: 📤 Ingesting chunk`)
    print(`   - Chunk ID: ${cid}`)
    print(`   - Text length: ${t.length} chars`)
    print(`   - Text preview: "${t.substring(0, 100)}..."`)
    
    await this.ensureConnected()
    await this.sendRequest("ingest", {
      chunk_id: cid,
      text: t,
      created_at: cat
    })
    
    print(`RemoteVectorMemoryClient: ✅ Chunk ingested successfully!`)
  }

  public async search(query: string, topK: number = 3): Promise<Array<{score: number; text: string; created_at?: number}>> {
    const q = (query || "").trim()
    if (!q) return []
    await this.ensureConnected()
    const resp = await this.sendRequest("search", {query: q, top_k: topK})
    const matches = resp?.matches
    if (!Array.isArray(matches)) return []
    return matches
  }

  /**
   * Delete specific chunks from the VectorDB
   */
  public async deleteChunks(chunkIds: string[]): Promise<number> {
    if (!chunkIds || chunkIds.length === 0) {
      print("RemoteVectorMemoryClient: ⚠️ No chunk IDs provided for deletion")
      return 0
    }

    print(`RemoteVectorMemoryClient: 🗑️ Deleting ${chunkIds.length} chunks...`)
    print(`   - Chunk IDs: ${chunkIds.join(", ")}`)

    await this.ensureConnected()
    const resp = await this.sendRequest("delete", {chunk_ids: chunkIds})

    const deletedCount = resp?.deleted_count || 0
    print(`RemoteVectorMemoryClient: ✅ Successfully deleted ${deletedCount} chunks`)
    return deletedCount
  }

  /**
   * List all chunks with pagination
   */
  public async listChunks(limit: number = 100, offset: number = 0): Promise<{
    chunks: Array<{chunk_id: string; point_id: number; text: string; created_at: number; text_preview: string}>;
    total_count: number;
    has_more: boolean;
  }> {
    print(`RemoteVectorMemoryClient: 📋 Listing chunks (limit: ${limit}, offset: ${offset})...`)

    await this.ensureConnected()
    const resp = await this.sendRequest("list", {limit, offset})

    const chunks = resp?.chunks || []
    const totalCount = resp?.total_count || 0
    const hasMore = resp?.has_more || false

    print(`RemoteVectorMemoryClient: ✅ Retrieved ${chunks.length} chunks (total: ${totalCount}, has_more: ${hasMore})`)
    return {
      chunks,
      total_count: totalCount,
      has_more: hasMore
    }
  }

  /**
   * Get total count of chunks in the collection
   */
  public async getChunkCount(): Promise<number> {
    print("RemoteVectorMemoryClient: 🔢 Getting chunk count...")

    await this.ensureConnected()
    const resp = await this.sendRequest("count", {})

    const count = resp?.count || 0
    print(`RemoteVectorMemoryClient: ✅ Collection contains ${count} chunks`)
    return count
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket && this.socket.readyState === 1) {
      return
    }

    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      try {
        if (this.enableDebugLogging) {
          print(`RemoteVectorMemoryClient: Connecting to ${this.wsUrl}`)
        }

        this.socket = this.internetModule.createWebSocket(this.wsUrl)
        this.socket.binaryType = "blob"

        this.socket.onopen = () => {
          if (this.enableDebugLogging) {
            print("RemoteVectorMemoryClient: WebSocket open")
          }
          resolve()
        }

        this.socket.onmessage = async (event: WebSocketMessageEvent) => {
          try {
            const raw = event.data instanceof Blob ? await event.data.text() : (event.data as string)
            const msg = JSON.parse(raw)
            const id = msg?.id
            if (!id || !this.pending.has(id)) {
              return
            }
            const pending = this.pending.get(id)!
            this.pending.delete(id)

            if (msg?.ok === false) {
              pending.reject(msg?.error || "Remote vector service error")
            } else {
              pending.resolve(msg)
            }
          } catch (error) {
            if (this.enableDebugLogging) {
              print(`RemoteVectorMemoryClient: Failed to handle message: ${error}`)
            }
          }
        }

        this.socket.onerror = () => {
          if (this.enableDebugLogging) {
            print("RemoteVectorMemoryClient: WebSocket error")
          }
        }

        this.socket.onclose = (event: WebSocketCloseEvent) => {
          if (this.enableDebugLogging) {
            print(`RemoteVectorMemoryClient: WebSocket closed (code=${event.code})`)
          }
          // Reject all pending requests
          this.pending.forEach((p) => p.reject("WebSocket closed"))
          this.pending.clear()
          this.socket = null
          this.connectPromise = null
        }
      } catch (error) {
        this.socket = null
        this.connectPromise = null
        reject(error)
      }
    })

    try {
      await this.connectPromise
    } finally {
      // keep connectPromise cached until closed; it's reused for concurrent callers
    }
  }

  private async sendRequest(op: "reset" | "ingest" | "search" | "delete" | "list" | "count", payload: any): Promise<any> {
    const id = this.nextId()
    
    print(`RemoteVectorMemoryClient: 📡 Sending ${op} request (ID: ${id})`)

    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== 1) {
        print(`RemoteVectorMemoryClient: ❌ WebSocket not connected (state: ${this.socket?.readyState})`)
        reject("WebSocket not connected")
        return
      }

      this.pending.set(id, {resolve, reject})

      const msg = JSON.stringify({id, op, ...payload})
      try {
        this.socket.send(msg)
        print(`RemoteVectorMemoryClient: ✅ Request sent successfully`)
      } catch (error) {
        print(`RemoteVectorMemoryClient: ❌ Send failed: ${error}`)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  private nextId(): string {
    this.requestCounter++
    return `req_${Date.now()}_${this.requestCounter}`
  }
}

