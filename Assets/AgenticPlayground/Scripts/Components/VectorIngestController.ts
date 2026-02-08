import {SummaryASRController} from "../ASR/SummaryASRController"
import {OpenAIEmbedder} from "../Core/OpenAIEmbedder"
import {RemoteVectorMemoryClient} from "../Storage/RemoteVectorMemoryClient"
import {SummaryStorage} from "../Storage/SummaryStorage"
import {VectorStore} from "../Storage/VectorStore"

/**
 * VectorIngestController - Minimal ingestion controller for latest-session VectorStore.
 *
 * Demo scope:
 * - Audio transcript only (from SummaryStorage / SummaryASR mic session).
 * - Session lifecycle tied to SummaryASRController mic start/stop.
 * - Overwrites the latest vector session on each recording start.
 */
@component
export class VectorIngestController extends BaseScriptComponent {
  @input
  @hint("Reference to SummaryASRController (mic start/stop events)")
  summaryASRController: SummaryASRController = null

  @input
  @hint("Reference to SummaryStorage (source of truth for accumulated transcript text)")
  summaryStorage: SummaryStorage = null

  @ui.group_start("Vector Mode")
  @input
  @hint("Use remote local-computer VectorDB service (Qdrant via WebSocket). If false, uses on-device Persistent Storage vector store.")
  useRemoteVectorService: boolean = false

  @input
  @allowUndefined
  @hint("InternetModule asset required for WebSocket connection (Preview/internal demos)")
  internetModule: InternetModule = null

  @input
  @hint("WebSocket URL for the local vector service")
  remoteWsUrl: string = "ws://127.0.0.1:8787/ws"
  @ui.group_end

  @input
  @hint("Enable vector ingestion")
  enableIngestion: boolean = true

  @input
  @hint("Enable debug logging")
  enableDebugLogging: boolean = true

  @ui.group_start("Chunking")
  @input
  @hint("Chunk size in characters (30 for testing, 120+ for production)")
  chunkSizeChars: number = 30

  @input
  @hint("Chunk overlap in characters")
  chunkOverlapChars: number = 5
  @ui.group_end

  @ui.group_start("Embedding")
  @input
  @hint("OpenAI model for embeddings (LLM vectorization)")
  embeddingModel: string = "gpt-4o-mini"

  @input
  @hint("Embedding dimensions (fixed length vector)")
  embeddingDimensions: number = 64
  @ui.group_end

  private embedder: OpenAIEmbedder | null = null
  private vectorStore: VectorStore | null = null
  private remoteClient: RemoteVectorMemoryClient | null = null

  private lastStoredText: string = ""
  private buffer: string = ""
  private isSessionActive: boolean = false
  private isFlushing: boolean = false

  onAwake() {
    // Always log so it's obvious whether this component is present in the scene.
    print("VectorIngestController: 🌱 onAwake - Component is present in scene")
    print(`VectorIngestController: 🔧 Configuration - useRemoteVectorService: ${this.useRemoteVectorService}, wsUrl: ${this.remoteWsUrl}`)
    this.createEvent("OnStartEvent").bind(this.initialize.bind(this))
  }

  private initialize(): void {
    print("VectorIngestController: 📋 Initializing...")
    print(`VectorIngestController: - Ingestion enabled: ${this.enableIngestion}`)
    print(`VectorIngestController: - Remote mode: ${this.useRemoteVectorService}`)
    print(`VectorIngestController: - WebSocket URL: ${this.remoteWsUrl}`)
    
    if (this.enableDebugLogging) {
      print(
        `VectorIngestController: initialize (enabled=${this.enableIngestion}, remote=${this.useRemoteVectorService}, ws=${this.remoteWsUrl})`
      )
    }
    if (!this.enableIngestion) {
      if (this.enableDebugLogging) {
        print("VectorIngestController: ⚠️ Ingestion disabled - component inactive")
      }
      return
    }

    if (!this.summaryASRController) {
      print("VectorIngestController: ❌ ERROR - SummaryASRController not assigned!")
      return
    } else {
      print("VectorIngestController: ✅ SummaryASRController connected")
    }

    if (!this.summaryStorage) {
      print("VectorIngestController: ❌ ERROR - SummaryStorage not assigned!")
      return
    } else {
      print("VectorIngestController: ✅ SummaryStorage connected")
    }

    this.embedder = new OpenAIEmbedder({
      model: this.embeddingModel,
      dimensions: this.embeddingDimensions,
      enableDebugLogging: this.enableDebugLogging
    })
    this.vectorStore = new VectorStore(this.embedder, {enableDebugLogging: this.enableDebugLogging})

    if (this.useRemoteVectorService) {
      print("VectorIngestController: 🌐 Remote VectorDB mode selected")
      if (!this.internetModule) {
        print("VectorIngestController: ⚠️ WARNING - useRemoteVectorService=true but InternetModule not assigned!")
        print("VectorIngestController: ℹ️ You need to add an InternetModule asset in Lens Studio")
      } else {
        print("VectorIngestController: ✅ InternetModule connected")
        this.remoteClient = new RemoteVectorMemoryClient(this.internetModule, this.remoteWsUrl, {
          enableDebugLogging: this.enableDebugLogging
        })
        print(`VectorIngestController: 🔌 Remote client created for ${this.remoteWsUrl}`)
      }

      // VectorDB-only persistence: when remote vector service is enabled, disable
      // SummaryStorage Persistent Storage writes/exports so transcript persistence lives only in VectorDB.
      if (this.summaryStorage) {
        const anyStorage = this.summaryStorage as any
        if ("enablePersistentStorage" in anyStorage) {
          anyStorage.enablePersistentStorage = false
          print("VectorIngestController: 🚫 Disabled SummaryStorage.enablePersistentStorage")
        }
        if ("enableStorageExports" in anyStorage) {
          anyStorage.enableStorageExports = false
          print("VectorIngestController: 🚫 Disabled SummaryStorage.enableStorageExports")
        }

        print("VectorIngestController: ✅ VectorDB-only mode enabled (SummaryStorage persistent storage disabled)")
      }
    } else {
      print("VectorIngestController: 💾 Local on-device VectorStore mode selected")
    }

    this.bindSessionEvents()
    this.bindStorageEvents()

    print("VectorIngestController: ✅ Initialized successfully")
    if (this.enableDebugLogging) {
      print("VectorIngestController: 🎬 Ready to ingest transcript chunks into VectorDB")
    }
  }

  private bindSessionEvents(): void {
    if (!this.summaryASRController) return

    if (this.summaryASRController.onSessionStarted && this.summaryASRController.onSessionStarted.add) {
      this.summaryASRController.onSessionStarted.add(() => {
        this.handleSessionStarted()
      })
      if (this.enableDebugLogging) {
        print("VectorIngestController: Bound to SummaryASRController.onSessionStarted")
      }
    }

    if (this.summaryASRController.onSessionEnded && this.summaryASRController.onSessionEnded.add) {
      this.summaryASRController.onSessionEnded.add(() => {
        this.handleSessionEnded()
      })
      if (this.enableDebugLogging) {
        print("VectorIngestController: Bound to SummaryASRController.onSessionEnded")
      }
    }
  }

  private bindStorageEvents(): void {
    if (!this.summaryStorage) return

    if (this.summaryStorage.onTextStored && this.summaryStorage.onTextStored.add) {
      this.summaryStorage.onTextStored.add((fullText: string) => {
        this.handleTextStored(fullText)
      })

      if (this.enableDebugLogging) {
        print("VectorIngestController: Bound to SummaryStorage.onTextStored")
      }
    }
  }

  private handleSessionStarted(): void {
    if (!this.enableIngestion) return

    this.isSessionActive = true
    this.lastStoredText = ""
    this.buffer = ""

    // Overwrite latest session for demo (local or remote)
    if (this.useRemoteVectorService && this.remoteClient) {
      this.remoteClient
        .resetLatestSession()
        .then(() => {
          if (this.enableDebugLogging) {
            print("VectorIngestController: Remote vector session reset")
          }
        })
        .catch((e) => {
          print(`VectorIngestController: Remote reset failed: ${e}`)
        })
    } else if (this.vectorStore) {
      this.vectorStore.startNewSession()
    }

    if (this.enableDebugLogging) {
      print("VectorIngestController: 🎬 Session started -> cleared latest vector memory")
    }
  }

  private handleSessionEnded(): void {
    if (!this.enableIngestion) return

    this.isSessionActive = false

    if (this.enableDebugLogging) {
      print("VectorIngestController: 🛑 Session ended -> flushing remaining buffer")
    }

    this.flushBuffer()
  }

  private handleTextStored(fullText: string): void {
    if (this.enableDebugLogging) {
      print(`VectorIngestController: 📥 handleTextStored called - fullText length: ${fullText ? fullText.length : 0}`)
      print(`VectorIngestController: 📊 State - enableIngestion: ${this.enableIngestion}, isSessionActive: ${this.isSessionActive}`)
    }
    
    if (!this.enableIngestion || !this.isSessionActive) {
      if (this.enableDebugLogging) {
        print(`VectorIngestController: ⏸️ Skipping - ingestion disabled or session inactive`)
      }
      return
    }
    
    if (!fullText || typeof fullText !== "string") {
      if (this.enableDebugLogging) {
        print(`VectorIngestController: ⚠️ Invalid fullText provided`)
      }
      return
    }

    // Compute delta since last stored full text
    const prev = this.lastStoredText || ""
    let delta = ""

    if (prev.length > 0 && fullText.startsWith(prev)) {
      delta = fullText.substring(prev.length)
      if (this.enableDebugLogging) {
        print(`VectorIngestController: 📝 Delta text: ${delta.length} new chars (prev: ${prev.length}, full: ${fullText.length})`)
      }
    } else if (prev.length === 0) {
      delta = fullText
      if (this.enableDebugLogging) {
        print(`VectorIngestController: 📝 First text: ${delta.length} chars`)
      }
    } else {
      // Storage was cleared or changed unexpectedly; treat as reset.
      delta = fullText
      if (this.enableDebugLogging) {
        print("VectorIngestController: Detected non-prefix update; resetting delta tracking")
      }
    }

    this.lastStoredText = fullText

    const normalizedDelta = this.normalizeDelta(delta)
    if (!normalizedDelta) {
      if (this.enableDebugLogging) {
        print(`VectorIngestController: ⚠️ Normalized delta is empty, skipping`)
      }
      return
    }

    this.buffer += (this.buffer.length > 0 ? " " : "") + normalizedDelta
    
    if (this.enableDebugLogging) {
      print(`VectorIngestController: 📦 Buffer updated - size: ${this.buffer.length} chars`)
      print(`VectorIngestController: 🔍 Buffer preview: "${this.buffer.substring(0, 100)}..."`)
    }

    this.maybeFlushChunks()
  }

  private normalizeDelta(delta: string): string {
    if (!delta) return ""
    const cleaned = delta.replace(/\s+/g, " ").trim()
    return cleaned
  }

  private maybeFlushChunks(): void {
    if (this.isFlushing) {
      if (this.enableDebugLogging) {
        print(`VectorIngestController: ⏸️ Already flushing, skipping`)
      }
      return
    }

    const size = Math.max(30, this.chunkSizeChars || 30)
    const overlap = Math.max(0, Math.min(this.chunkOverlapChars || 0, size - 1))
    const stride = Math.max(10, size - overlap)

    if (this.buffer.length < size) {
      if (this.enableDebugLogging) {
        print(`VectorIngestController: ⏳ Buffer too small (${this.buffer.length} < ${size}), waiting for more text`)
      }
      return
    }

    if (this.enableDebugLogging) {
      print(`VectorIngestController: 🚀 Buffer ready to flush! (${this.buffer.length} >= ${size})`)
      print(`VectorIngestController: 📋 Chunk config - size: ${size}, overlap: ${overlap}, stride: ${stride}`)
    }

    // Flush as many full chunks as we can
    this.isFlushing = true

    const flushAsync = async () => {
      try {
        let chunkCount = 0
        while (this.buffer.length >= size) {
          const chunkText = this.buffer.substring(0, size).trim()
          this.buffer = this.buffer.substring(stride).trim()

          if (chunkText.length > 0) {
            chunkCount++
            print(`VectorIngestController: 📤 Flushing chunk #${chunkCount} (${chunkText.length} chars): "${chunkText.substring(0, 50)}..."`)
            
            if (this.useRemoteVectorService && this.remoteClient) {
              print(`VectorIngestController: 🌐 Sending to REMOTE VectorDB...`)
              await this.remoteClient.ingestChunk(chunkText)
              print(`VectorIngestController: ✅ Chunk #${chunkCount} sent to remote VectorDB successfully!`)
            } else if (this.vectorStore) {
              print(`VectorIngestController: 💾 Storing to LOCAL VectorStore...`)
              await this.vectorStore.addChunk(chunkText)
              print(`VectorIngestController: ✅ Chunk #${chunkCount} stored locally!`)
            }
          }
        }
        print(`VectorIngestController: ✅ Flush completed - processed ${chunkCount} chunks`)
      } catch (error) {
        print(`VectorIngestController: ❌ Chunk flush failed: ${error}`)
      } finally {
        this.isFlushing = false
      }
    }

    // Fire-and-forget async flush (Lens Studio supports async/await in TS scripts used here).
    flushAsync()
  }

  private flushBuffer(): void {
    if (this.isFlushing) {
      if (this.enableDebugLogging) {
        print(`VectorIngestController: ⏸️ Already flushing buffer`)
      }
      return
    }

    const leftover = (this.buffer || "").trim()
    if (leftover.length === 0) {
      if (this.enableDebugLogging) {
        print(`VectorIngestController: ℹ️ No leftover buffer to flush`)
      }
      return
    }

    print(`VectorIngestController: 📤 Flushing leftover buffer (${leftover.length} chars)`)
    this.isFlushing = true

    const flushAsync = async () => {
      try {
        if (this.useRemoteVectorService && this.remoteClient) {
          print(`VectorIngestController: 🌐 Sending leftover to REMOTE VectorDB...`)
          await this.remoteClient.ingestChunk(leftover)
          print(`VectorIngestController: ✅ Leftover sent to remote VectorDB!`)
        } else if (this.vectorStore) {
          print(`VectorIngestController: 💾 Storing leftover to LOCAL VectorStore...`)
          await this.vectorStore.addChunk(leftover)
          print(`VectorIngestController: ✅ Leftover stored locally!`)
        }
        if (this.enableDebugLogging) {
          print(`VectorIngestController: ✅ Flushed leftover chunk (${leftover.length} chars)`)
        }
      } catch (error) {
        print(`VectorIngestController: ❌ Leftover flush failed: ${error}`)
      } finally {
        this.buffer = ""
        this.isFlushing = false
      }
    }

    flushAsync()
  }
}
