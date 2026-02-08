import {OpenAIEmbedder} from "../Core/OpenAIEmbedder"

export interface VectorChunk {
  id: string
  text: string
  embedding: number[]
  createdAt: number
  source: "audio_transcript"
}

export interface VectorSession {
  version: number
  sessionId: string
  createdAt: number
  chunks: VectorChunk[]
}

/**
 * VectorStore - Latest-session persistent vector store (demo scope).
 *
 * - Stores ONLY the latest session (overwrites on start).
 * - Persists to Lens Studio Persistent Storage when available.
 * - Uses brute-force cosine similarity (small dataset: 2–3 min sessions).
 */
export class VectorStore {
  private readonly STORAGE_KEY = "agentic_vectordb_latest_session"
  private readonly VERSION = 1

  private embedder: OpenAIEmbedder
  private enableDebugLogging: boolean

  private session: VectorSession | null = null
  private persistentStore: any = null

  constructor(embedder: OpenAIEmbedder, options?: {enableDebugLogging?: boolean}) {
    this.embedder = embedder
    this.enableDebugLogging = options?.enableDebugLogging ?? false

    if (typeof global !== "undefined" && global.persistentStorageSystem) {
      this.persistentStore = global.persistentStorageSystem.store
    }
  }

  public startNewSession(): VectorSession {
    const now = Date.now()
    this.session = {
      version: this.VERSION,
      sessionId: `vector_session_${now}`,
      createdAt: now,
      chunks: []
    }
    this.save()

    if (this.enableDebugLogging) {
      print(`VectorStore: Started new session ${this.session.sessionId} (overwriting latest)`)
    }

    return this.session
  }

  public getSession(): VectorSession | null {
    if (!this.session) {
      this.load()
    }
    return this.session
  }

  public clearLatestSession(): void {
    this.session = {
      version: this.VERSION,
      sessionId: `vector_session_${Date.now()}`,
      createdAt: Date.now(),
      chunks: []
    }
    this.save()
  }

  public async addChunk(text: string): Promise<void> {
    const session = this.getOrCreateSession()
    const normalized = (text || "").trim()
    if (!normalized) return

    // Cap total chunks for demo safety
    const MAX_CHUNKS = 60
    if (session.chunks.length >= MAX_CHUNKS) {
      if (this.enableDebugLogging) {
        print(`VectorStore: Max chunks reached (${MAX_CHUNKS}); skipping new chunk`)
      }
      return
    }

    const embedding = await this.embedder.embed(normalized)
    const chunk: VectorChunk = {
      id: `chunk_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      text: normalized,
      embedding,
      createdAt: Date.now(),
      source: "audio_transcript"
    }

    session.chunks.push(chunk)
    this.save()

    if (this.enableDebugLogging) {
      print(`VectorStore: Added chunk (${normalized.length} chars). Total: ${session.chunks.length}`)
    }
  }

  public async search(query: string, topK: number = 3): Promise<Array<{chunk: VectorChunk; score: number}>> {
    const session = this.getSession()
    if (!session || !session.chunks || session.chunks.length === 0) {
      return []
    }

    const q = (query || "").trim()
    if (!q) return []

    const queryEmbedding = await this.embedder.embed(q)

    const scored = session.chunks
      .map((chunk) => {
        const score = this.cosineSimilarity(queryEmbedding, chunk.embedding)
        return {chunk, score}
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, topK))

    if (this.enableDebugLogging) {
      print(
        `VectorStore: Search top ${topK} over ${session.chunks.length} chunks. Best score: ${scored[0]?.score ?? 0}`
      )
    }

    return scored
  }

  private getOrCreateSession(): VectorSession {
    const existing = this.getSession()
    if (existing) return existing
    return this.startNewSession()
  }

  private save(): void {
    try {
      if (!this.persistentStore || !this.session) return
      if (typeof this.persistentStore.putString !== "function") return
      this.persistentStore.putString(this.STORAGE_KEY, JSON.stringify(this.session))
    } catch (error) {
      if (this.enableDebugLogging) {
        print(`VectorStore: Save failed: ${error}`)
      }
    }
  }

  private load(): void {
    try {
      if (!this.persistentStore || typeof this.persistentStore.getString !== "function") {
        this.session = null
        return
      }
      const raw = this.persistentStore.getString(this.STORAGE_KEY)
      if (!raw || raw.length === 0) {
        this.session = null
        return
      }
      const parsed = JSON.parse(raw) as VectorSession
      if (!parsed || !parsed.chunks || !Array.isArray(parsed.chunks)) {
        this.session = null
        return
      }
      this.session = parsed
    } catch (error) {
      this.session = null
      if (this.enableDebugLogging) {
        print(`VectorStore: Load failed: ${error}`)
      }
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length === 0 || b.length === 0) return 0
    const n = Math.min(a.length, b.length)
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < n; i++) {
      const av = a[i]
      const bv = b[i]
      dot += av * bv
      na += av * av
      nb += bv * bv
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb)
    return denom === 0 ? 0 : dot / denom
  }
}

