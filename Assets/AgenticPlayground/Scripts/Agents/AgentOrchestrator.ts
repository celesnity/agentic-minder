import Event from "SpectaclesInteractionKit.lspkg/Utils/Event"
import { clearTimeout, setTimeout } from "SpectaclesInteractionKit.lspkg/Utils/FunctionTimingUtils"
import { ChatComponent } from "../Components/ChatComponent"
import { SummaryComponent } from "../Components/SummaryComponent"
import { GeminiAssistant } from "../Core/GeminiAssistant"
import { OpenAIAssistant } from "../Core/OpenAIAssistant"
import { StorageManager } from "../Storage/StorageManager"
import { ToolRouter } from "../Tools/ToolRouter"
import { OpenClawBridge } from "../Bridge/OpenClawBridge"
import { GlassQuery, OpenClawConnectionState } from "../Bridge/OpenClawTypes"
import { AgentLanguageInterface } from "./AgentLanguageInterface"
import { AgentMemorySystem } from "./AgentMemorySystem"
import { AgentToolExecutor } from "./AgentToolExecutor"
import { ChatMessage, SystemState } from "./AgentTypes"

/**
 * AgentOrchestrator - Central coordinator for the agentic learning system
 *
 * This is the core component that manages the entire agent flow as shown in the architecture diagram:
 * 1. Receives queries from ChatASRController
 * 2. Routes queries through the tool system (conversation, summary, spatial, diagram tools)
 * 3. Coordinates between different flows (Summary, Chat, Diagram)
 * 4. Manages LLM providers (OpenAI/Gemini)
 * 5. Integrates with bridge components for UI updates
 *
 * Architecture Flow:
 * ChatASRController → AgentOrchestrator → ToolExecutor → Tools → Bridges → UI Components
 */
@component
export class AgentOrchestrator extends BaseScriptComponent {
  // ================================
  // Component References
  // ================================

  @input
  @hint("OpenAI Assistant component for language model integration")
  openAIAssistant: OpenAIAssistant = null

  @input
  @hint("Gemini Assistant component for language model integration")
  geminiAssistant: GeminiAssistant = null

  @input
  @hint("Summary Layout component for reading summary context")
  summaryComponent: SummaryComponent = null // AgenticSummary component

  @input
  @hint("Chat Layout component for chat integration")
  chatComponent: ChatComponent = null // AgenticChat component

  @input
  @hint("Storage Manager for centralized storage control")
  storageManager: StorageManager = null

  @input
  @hint("Text display component for tool usage information")
  toolDisplayText: Text = null

  // ================================
  // Configuration
  // ================================

  @ui.group_start("System Configuration")
  @input
  enableSystem: boolean = true
  @input
  @hint("Enable test mode to use mock summary data when no real summary exists")
  enableTestMode: boolean = false
  @ui.group_end
  @ui.group_start("Agent Configuration")
  @input
  conversationContextMessages: number = 10
  @input toolTimeout: number = 15000 // 15 seconds
  @input maxRetries: number = 3
  @ui.group_end
  @ui.group_start("AI Provider Configuration")
  @input
  @widget(new ComboBoxWidget([new ComboBoxItem("openai", "OpenAI"), new ComboBoxItem("gemini", "Gemini")]))
  defaultProvider: string = "openai"
  @input enableVoiceOutput: boolean = true
  @ui.group_end
  @ui.group_start("Debug Configuration")
  @input
  enableDebugLogging: boolean = true
  @input showToolUsage: boolean = true
  @input showQueryRouting: boolean = true
  @ui.group_end
  @ui.group_start("OpenClaw Bridge Configuration")
  @input
  @hint("Enable routing queries through OpenClaw gateway instead of direct AI providers")
  enableOpenClaw: boolean = false
  @input
  @hint("OpenClaw server WebSocket URL (e.g., ws://172.16.98.166:18789)")
  openClawServerUrl: string = "ws://172.16.98.166:18789"
  @input
  @hint("Gateway auth token from openclaw.json gateway.auth.token (dev mode, no device signing)")
  openClawAuthToken: string = ""
  @input
  @hint("RemoteServiceModule reference for WebSocket creation")
  remoteServiceModule: RemoteServiceModule = null
  @input
  @hint("AudioComponent for native TTS playback (required when enableOpenClaw is true)")
  @allowUndefined
  ttsAudioComponent: AudioComponent
  @ui.group_end

  // ================================
  // Core System Components
  // ================================
  private languageInterface: AgentLanguageInterface = null
  private toolExecutor: AgentToolExecutor = null
  private memorySystem: AgentMemorySystem = null
  private toolRouter: ToolRouter = null

  // ================================
  // State Management
  // ================================

  private systemState: SystemState = null
  private isProcessingQuery: boolean = false
  private currentSessionId: string = ""
  private initialized: boolean = false
  private connectionMode: "direct" | "openclaw" = "direct"
  private openClawBridge: OpenClawBridge = null
  private ttsModule: TextToSpeechModule = null
  private isSpeakingNative: boolean = false

  // FIX: Track current conversation for voice completion events
  private currentQuery: string = ""
  private currentResponse: string = ""
  private accumulatedTranscription: string = "" // Track voice transcription separately
  private transcriptionSilenceTimer: any = null
  private lastTranscriptionTime: number = 0

  // ================================
  // Events
  // ================================

  public onQueryReceived: Event<string> = new Event<string>()
  public onQueryProcessed: Event<{ query: string; response: string; tool: string }> = new Event()
  public onVoiceCompleted: Event<{ query: string; response: string }> = new Event() // FIX: Voice completion event
  public onSystemStateChanged: Event<SystemState> = new Event<SystemState>()
  public onError: Event<string> = new Event<string>()
  public onSystemReset: Event<void> = new Event<void>() // FIX: Event for UI clearing

  // ================================
  // Lifecycle Methods
  // ================================

  onAwake() {
    if (this.enableDebugLogging) {
      print("AgentOrchestrator: Central orchestrator awakening")
    }

    // FIX: Ensure voice output is enabled at startup
    this.enableVoiceOutput = true
    print("AgentOrchestrator: Voice output explicitly enabled at startup")

    this.createEvent("OnStartEvent").bind(this.initialize)
  }

  // ================================
  // Initialization
  // ================================

  private initialize = (): void => {
    // FIX: Idempotence check
    if (this.initialized) {
      // Already initialized
      return
    }

    if (!this.enableSystem) {
      print("AgentOrchestrator: System disabled, skipping initialization")
      return
    }

    try {
      this.initializeComponents()
      this.setupConnections()
      this.initializeSystemState()
      this.initialized = true

      if (this.enableDebugLogging) {
        print("AgentOrchestrator: Central orchestrator initialized successfully")
        print(`AgentOrchestrator: Default provider: ${this.defaultProvider}`)
        print(`AgentOrchestrator: Tool timeout: ${this.toolTimeout}ms`)
      }
    } catch (error) {
      this.handleError(`Initialization failed: ${error}`)
    }
  }

  private initializeComponents(): void {
    // FIX: Validate that at least one AI assistant is available
    if (!this.openAIAssistant && !this.geminiAssistant) {
      throw new Error("No AI assistants configured. Please assign either OpenAI or Gemini assistant in the inspector.")
    }

    if (this.enableDebugLogging) {
      print(
        `AgentOrchestrator: 🔍 Available assistants - OpenAI: ${this.openAIAssistant ? "" : ""}, Gemini: ${this.geminiAssistant ? "" : ""}`
      )
    }

    // Initialize language interface
    // Initialize language interface
    try {
      this.languageInterface = new AgentLanguageInterface(
        this.openAIAssistant,
        this.geminiAssistant,
        this.defaultProvider as "openai" | "gemini",
        this.enableOpenClaw // deferInit: skip AI session init in OpenClaw mode to keep mic free for ASR
      )

      // No need to set default provider again as it's passed in constructor

      print(`AgentOrchestrator: Language interface created successfully with default: ${this.defaultProvider}`)
    } catch (error) {
      print(`AgentOrchestrator: Language interface initialization failed: ${error}`)
      throw new Error(`Language interface initialization failed: ${error}`)
    }

    // Initialize tool executor
    this.toolExecutor = new AgentToolExecutor(this.toolDisplayText)

    // Initialize memory system
    this.memorySystem = new AgentMemorySystem()

    // Initialize tool router with language interface and diagram storage from StorageManager
    const diagramStorage = this.storageManager ? this.storageManager.getDiagramStorage() : null
    this.toolRouter = new ToolRouter(this.languageInterface, diagramStorage)

    // Connect summary and chat storage to the tool router if available
    if (this.storageManager) {
      const summaryStorage = this.storageManager.getSummaryStorage()
      const chatStorage = this.storageManager.getChatStorage()

      if (summaryStorage) {
        this.toolRouter.setSummaryStorage(summaryStorage)
      }
      if (chatStorage) {
        this.toolRouter.setChatStorage(chatStorage)
      }
    }

    // Register the intelligent tool router as the main tool
    this.toolExecutor.registerTool({
      name: "intelligent_conversation",
      description: "Routes queries to appropriate specialized tools",
      parameters: this.toolRouter.getToolInfo().parameters,
      execute: async (args) => {
        const result = await this.toolRouter.routeQuery(args)
        return {
          ...result,
          executionTime: 0 // ExecutionTime will be set by ToolExecutor
        }
      }
    })

    // Initialize OpenClaw bridge if enabled
    if (this.enableOpenClaw) {
      this.openClawBridge = OpenClawBridge.getInstance()
      this.openClawBridge.setRemoteServiceModule(this.remoteServiceModule)
      this.openClawBridge.configure({
        serverUrl: this.openClawServerUrl,
        authToken: this.openClawAuthToken
      })

      // Auto-connect to OpenClaw
      this.openClawBridge.connect().then(() => {
        print("AgentOrchestrator: OpenClaw bridge connection initiated")
      }).catch((e) => {
        print("AgentOrchestrator: OpenClaw bridge connection failed: " + e)
      })
    }

    if (this.enableDebugLogging) {
      print("AgentOrchestrator: Core components initialized")
    }
  }

  private setupConnections(): void {
    // Setup language interface events
    if (this.languageInterface) {
      this.languageInterface.onTextUpdate.add((data) => {
        if (this.enableDebugLogging) {
          print(
            `AgentOrchestrator: 📝 LLM text update from ${data.provider} - completed: ${data.completed}, text: "${data.text?.substring(0, 50)}..."`
          )
        }

        // FIX: Accumulate transcription text when voice is enabled
        if (this.enableVoiceOutput && data.text && data.text.length > 0) {
          // Filter out system messages
          const isSystemMessage =
            data.text.includes("Websocket connected") ||
            data.text.includes("Session initialized") ||
            data.text.toLowerCase().includes("websocket")

          if (!isSystemMessage) {
            // Accumulate transcription text
            if (
              this.accumulatedTranscription.length > 0 &&
              !this.accumulatedTranscription.endsWith(" ") &&
              !data.text.startsWith(" ")
            ) {
              this.accumulatedTranscription += " "
            }
            this.accumulatedTranscription += data.text
            this.lastTranscriptionTime = Date.now()

            if (this.enableDebugLogging) {
              print(
                `AgentOrchestrator: Accumulated transcription: "${this.accumulatedTranscription}" (${this.accumulatedTranscription.length} chars)`
              )
            }

            // Reset silence timer - fire completion event after 2 seconds of silence
            if (this.transcriptionSilenceTimer) {
              clearTimeout(this.transcriptionSilenceTimer)
            }

            if (this.enableDebugLogging) {
              print(`AgentOrchestrator: Starting/resetting silence timer (2s)`)
            }

            this.transcriptionSilenceTimer = setTimeout(() => {
              if (this.accumulatedTranscription.length > 0 && this.currentQuery) {
                const finalTranscription = this.accumulatedTranscription.trim()

                if (this.enableDebugLogging) {
                  print(`AgentOrchestrator: 🔇 Transcription silence detected - firing voice completion`)
                  print(`AgentOrchestrator: 📄 Final transcription: "${finalTranscription}"`)
                }

                // Store the bot response now that we have the transcription
                const botMessage: ChatMessage = {
                  id: `msg_${Date.now()}_bot`,
                  type: "bot",
                  content: finalTranscription,
                  timestamp: Date.now(),
                  cardIndex: -1,
                  relatedTools: ["intelligent_conversation"]
                }

                // Store in ChatStorage through StorageManager
                if (this.storageManager && this.storageManager.getChatStorage()) {
                  const chatStorage = this.storageManager.getChatStorage()
                  chatStorage.addMessage({
                    id: botMessage.id,
                    type: "bot",
                    content: botMessage.content,
                    timestamp: botMessage.timestamp,
                    cardIndex: botMessage.cardIndex,
                    relatedTools: botMessage.relatedTools
                  })

                  if (this.enableDebugLogging) {
                    print(`AgentOrchestrator: 💾 Stored voice transcription in ChatStorage`)
                  }
                }

                // Also store in memory system for backward compatibility
                if (this.memorySystem) {
                  this.memorySystem.addChatMessage(botMessage)

                  // Update system state
                  this.systemState.chatHistory = this.memorySystem.getChatHistory()
                  this.onSystemStateChanged.invoke(this.systemState)
                } else {
                  print(`AgentOrchestrator: Memory system not available - cannot store bot message`)
                }

                // Fire voice completion event
                if (this.enableDebugLogging) {
                  print(`AgentOrchestrator: Firing onVoiceCompleted event with transcription`)
                }

                this.onVoiceCompleted.invoke({
                  query: this.currentQuery,
                  response: finalTranscription
                })

                // Don't clear transcription here - let it be cleared on next query
              }
            }, 2000) // 2 seconds of silence means transcription is complete
          }
        }

        // FIX: Also check for completion signals to fire voice event
        if (data.completed && this.enableVoiceOutput && this.accumulatedTranscription.length > 0) {
          if (this.enableDebugLogging) {
            print(`AgentOrchestrator: Text marked as completed - checking if we should fire voice event`)
          }

          // Fire completion event after a short delay
          setTimeout(() => {
            if (this.accumulatedTranscription.length > 0 && this.currentQuery) {
              const finalTranscription = this.accumulatedTranscription.trim()

              if (this.enableDebugLogging) {
                print(`AgentOrchestrator: Completion signal - firing voice completion with transcription`)
              }

              // Store and fire event (same as silence detection)
              const botMessage: ChatMessage = {
                id: `msg_${Date.now()}_bot`,
                type: "bot",
                content: finalTranscription,
                timestamp: Date.now(),
                cardIndex: -1,
                relatedTools: ["intelligent_conversation"]
              }

              // Store in ChatStorage through StorageManager
              if (this.storageManager && this.storageManager.getChatStorage()) {
                const chatStorage = this.storageManager.getChatStorage()
                chatStorage.addMessage({
                  id: botMessage.id,
                  type: "bot",
                  content: botMessage.content,
                  timestamp: botMessage.timestamp,
                  cardIndex: botMessage.cardIndex,
                  relatedTools: botMessage.relatedTools
                })
              }

              // Also store in memory system for backward compatibility
              if (this.memorySystem) {
                this.memorySystem.addChatMessage(botMessage)
                this.systemState.chatHistory = this.memorySystem.getChatHistory()
                this.onSystemStateChanged.invoke(this.systemState)
              }

              this.onVoiceCompleted.invoke({
                query: this.currentQuery,
                response: finalTranscription
              })

              // Clear the timer to prevent duplicate events
              if (this.transcriptionSilenceTimer) {
                clearTimeout(this.transcriptionSilenceTimer)
                this.transcriptionSilenceTimer = null
              }
            }
          }, 1000) // 1 second delay for completion signal
        }
      })

      this.languageInterface.onError.add((data) => {
        this.handleError(`LLM Error (${data.provider}): ${data.error}`)
      })
    }

    // Setup OpenClaw bridge events
    if (this.openClawBridge) {
      this.openClawBridge.onConnectionStateChanged.add((state: OpenClawConnectionState) => {
        if (state.status === "connected") {
          this.connectionMode = "openclaw"
          print("AgentOrchestrator: Switched to OpenClaw mode")

          // Auto-test: send a test query when connected in test mode
          // Delay to allow session key fetch to complete
          if (this.enableTestMode) {
            setTimeout(() => {
              print("AgentOrchestrator: [TEST] Sending test query via OpenClaw...")
              this.processUserQuery("Hello, what is 2+2?").then((response) => {
                print("AgentOrchestrator: [TEST] OpenClaw response: " + response.substring(0, 200))
              }).catch((e) => {
                print("AgentOrchestrator: [TEST] OpenClaw test failed: " + e)
              })
            }, 3000)
          }
        } else if (state.status === "disconnected") {
          this.connectionMode = "direct"
          print("AgentOrchestrator: Switched to direct AI mode (fallback)")
        }
      })

      this.openClawBridge.onError.add((error) => {
        this.handleError("[OpenClaw] " + error.message)
      })
    }

    // Setup tool executor events
    if (this.toolExecutor) {
      this.toolExecutor.onToolExecuted.add((data) => {
        if (this.enableDebugLogging) {
          print(`AgentOrchestrator: Tool '${data.tool}' executed in ${data.duration}ms`)
        }
      })

      this.toolExecutor.onToolFailed.add((data) => {
        this.handleError(`Tool '${data.tool}' failed: ${data.error}`)
      })
    }

    if (this.enableDebugLogging) {
      print("AgentOrchestrator: Component connections established")
    }
  }

  private initializeSystemState(): void {
    this.currentSessionId = `session_${Date.now()}`

    this.systemState = {
      currentStep: "idle",
      summaryData: null,
      chatHistory: [],
      diagramState: null,
      sessionId: this.currentSessionId,
      timestamp: Date.now()
    }

    // Storage reset is now handled by StorageManager
    // If StorageManager has resetStorageOnAwake=true, it will handle all resets

    if (this.enableDebugLogging) {
      print(`AgentOrchestrator: 📋 System state initialized (Session: ${this.currentSessionId})`)
    }
  }

  // ================================
  // Public API - Main Query Processing
  // ================================

  /**
   * Main entry point for processing user queries from ChatASRController
   * This is the core method that implements the agent flow from the architecture diagram
   */
  public async processUserQuery(query: string, context?: any): Promise<string> {
    // FIX: Lazy Initialization pattern
    // If system is enabled but not initialized, try to initialize it now (jit)
    if (!this.initialized && this.enableSystem) {
      if (this.enableDebugLogging) {
        print("AgentOrchestrator: ⚠️ System requested but not initialized. Attempting lazy initialization...")
      }
      try {
        // Attempt to initialize
        this.initialize()
      } catch (e) {
        print(`AgentOrchestrator: Lazy initialization failed: ${e}`)
      }
    }

    if (!this.initialized || !this.enableSystem) {
      const error = !this.enableSystem
        ? "System is disabled in Inspector"
        : "System failed to initialize. Check logs for 'Initialization failed' errors."

      this.handleError(error)
      return error
    }

    if (this.isProcessingQuery) {
      if (this.enableDebugLogging) {
        print("AgentOrchestrator: ⏳ Already processing a query, queuing...")
      }
      // In a production system, you might want to queue this
      return "System busy, please wait..."
    }

    this.isProcessingQuery = true
    this.onQueryReceived.invoke(query)

    // FIX: Store current query for voice completion tracking
    this.currentQuery = query
    this.currentResponse = ""
    this.accumulatedTranscription = "" // Reset transcription for new query

    // Clear any pending transcription timer
    if (this.transcriptionSilenceTimer) {
      clearTimeout(this.transcriptionSilenceTimer)
      this.transcriptionSilenceTimer = null
    }

    try {
      if (this.enableDebugLogging && this.showQueryRouting) {
        print(`AgentOrchestrator: 📥 Processing query: "${query.substring(0, 100)}..."`)
      }

      // Update system state
      this.systemState.currentStep = "chat"
      this.systemState.timestamp = Date.now()

      // Prepare context for tool execution
      const toolArgs = {
        query: query,
        context: this.getConversationContext(),
        summaryContext: this.getSummaryContext(),
        maxLength: 300, // Character limit for responses
        educationalFocus: true,
        textOnly: !this.enableVoiceOutput // Disable voice if enableVoiceOutput is false
      }

      // Log the summary context being passed
      if (this.enableDebugLogging) {
        const summaryCtx = this.getSummaryContext()
        if (summaryCtx) {
          print(
            `AgentOrchestrator: 📚 Summary context: title="${summaryCtx.title}", sections=${summaryCtx.summaries ? summaryCtx.summaries.length : 0}, mockData=${summaryCtx.mockData || false}`
          )
        } else {
          print(`AgentOrchestrator: 📚 No summary context available`)
        }
      }

      let response = "I'm having trouble processing that request."

      // Route through OpenClaw bridge if connected, otherwise use direct AI
      if (this.connectionMode === "openclaw" && this.openClawBridge?.isConnected()) {
        // OpenClaw mode: route query through the gateway bridge
        if (this.enableDebugLogging) {
          print("AgentOrchestrator: Routing through OpenClaw bridge")
        }

        try {
          const glassQuery: GlassQuery = {
            text: query,
            imageData: context?.cameraFrame,
            displayMode: "chat",
            maxResponseLength: 300
          }

          response = await this.openClawBridge.sendQuery(glassQuery)

          // Update tool display for OpenClaw
          if (this.toolDisplayText) {
            this.toolDisplayText.text = "OpenClaw Agent"
          }
        } catch (e) {
          print("AgentOrchestrator: OpenClaw query failed, falling back to direct mode: " + e)
          this.connectionMode = "direct"
          // Fall through to direct mode below
        }
      }

      if (this.connectionMode === "direct" || response === "I'm having trouble processing that request.") {
        // Direct mode: use local tool routing (existing behavior)
        const result = await this.toolExecutor.executeTool("intelligent_conversation", toolArgs)

        // Update tool display with routing information
        this.updateToolDisplay(query, result)

        if (result.success && result.result) {
          if (typeof result.result === "string") {
            response = result.result
          } else if (result.result.message) {
            // FIX: Handle ChatResponse structure from GeneralConversationTool
            response = result.result.message
          } else if (result.result.response) {
            response = result.result.response
          } else if (result.result.result) {
            response = result.result.result
          } else {
            // FIX: Better error handling - show what we actually got
            print(`AgentOrchestrator: Unexpected result structure: ${JSON.stringify(result.result)}`)
            response = "Unexpected response format from tool"
          }
        } else {
          response = result.error || "Tool execution failed"
        }
      }

      // FIX: Handle voice mode responses (Hybrid Architecture)
      let isVoicePlaceholder = false
      if (response === "[Voice response - transcription pending]") {
        // Native Voice Mode (e.g. General Conversation):
        // Response is being streamed via audio, we wait for transcription
        if (this.enableVoiceOutput) {
          print(`AgentOrchestrator: Voice mode detected - will use transcription when available`)
          isVoicePlaceholder = true
          response = "" // Empty response for now, prevents duplicate display
        }
      } else if (this.enableVoiceOutput && response && response.length > 0) {
        // Text-First Mode: We have the text, need to speak it aloud
        print(`AgentOrchestrator: Text response detected with voice enabled - requesting speech`)
        if (this.connectionMode === "openclaw") {
          // OpenClaw mode: use native Spectacles TTS (no mic conflict, no duplicate cards)
          this.speakNative(response)
        } else {
          // Direct mode: use AI provider TTS (existing behavior)
          this.languageInterface.speak(response)
        }
      }

      // FIX: Store current response for voice completion tracking
      this.currentResponse = response

      // Store conversation in memory only if not a voice placeholder
      if (!isVoicePlaceholder) {
        this.storeConversation(query, response)
      } else {
        // For voice mode, only store the user query for now
        const userMessage: ChatMessage = {
          id: `msg_${Date.now()}_user`,
          type: "user",
          content: query,
          timestamp: Date.now(),
          cardIndex: -1,
          relatedTools: []
        }

        // Store in ChatStorage through StorageManager
        if (this.storageManager && this.storageManager.getChatStorage()) {
          const chatStorage = this.storageManager.getChatStorage()
          chatStorage.addMessage({
            id: userMessage.id,
            type: "user",
            content: userMessage.content,
            timestamp: userMessage.timestamp,
            cardIndex: userMessage.cardIndex,
            relatedTools: userMessage.relatedTools
          })
        }

        // Also store in memory system for backward compatibility
        this.memorySystem.addChatMessage(userMessage)
      }

      // Fire completion event
      this.onQueryProcessed.invoke({
        query: query,
        response: response,
        tool: "intelligent_conversation"
      })

      if (this.enableDebugLogging) {
        print(`AgentOrchestrator: Query processed successfully, response length: ${response.length}`)
      }

      return response
    } catch (error) {
      const errorMessage = `Query processing failed: ${error}`
      this.handleError(errorMessage)
      return errorMessage
    } finally {
      this.isProcessingQuery = false
      // FIX: Delay clearing current conversation to allow voice completion event to fire
      setTimeout(() => {
        this.currentQuery = ""
        this.currentResponse = ""
        // Also clear accumulated transcription if it wasn't used
        if (this.accumulatedTranscription.length > 0) {
          print(
            `AgentOrchestrator: Clearing unused transcription: "${this.accumulatedTranscription.substring(0, 50)}..."`
          )
          this.accumulatedTranscription = ""
        }
      }, 5000) // 5 second delay to ensure voice completion event can access these values
    }
  }

  // ================================
  // Context Management
  // ================================

  private getConversationContext(): ChatMessage[] {
    if (!this.memorySystem) {
      return []
    }

    return this.memorySystem.getChatHistory().slice(-this.conversationContextMessages)
  }

  private getSummaryContext(): any {
    // Get the real summary from SummaryStorage through StorageManager
    if (this.storageManager && this.storageManager.getSummaryStorage()) {
      const summaryStorage = this.storageManager.getSummaryStorage()
      const currentSummary = summaryStorage.getCurrentSummary()

      if (currentSummary && currentSummary.sections && currentSummary.sections.length > 0) {
        // Convert to the format expected by SummaryTool
        return {
          title: currentSummary.summaryTitle || "Lecture Summary",
          summaries: currentSummary.sections.map((section) => ({
            title: section.title,
            content: section.content,
            keywords: section.keywords || []
          })),
          originalText: currentSummary.originalText,
          totalCharacters: currentSummary.totalCharacters,
          timestamp: currentSummary.createdAt || Date.now()
        }
      }
    }

    // Only use test data if explicitly in test mode and no real summary exists
    if (this.enableTestMode) {
      return {
        title: "AI & Machine Learning Lecture Summary",
        content:
          "This lecture covered fundamental concepts in artificial intelligence and machine learning. Key topics included neural networks, deep learning architectures, supervised and unsupervised learning, and practical applications in computer vision and natural language processing. The instructor demonstrated how backpropagation works in neural networks and discussed the importance of data preprocessing and feature engineering. Real-world examples were provided showing how these techniques are applied in industry, including image recognition, recommendation systems, and autonomous vehicles.",
        keyPoints: [
          "Neural networks and deep learning fundamentals",
          "Supervised vs unsupervised learning approaches",
          "Backpropagation algorithm and gradient descent",
          "Computer vision and NLP applications",
          "Industry applications and case studies"
        ],
        timestamp: Date.now(),
        mockData: true
      }
    }

    return null
  }

  private storeConversation(query: string, response: string): void {
    const timestamp = Date.now()

    // Store user message
    const userMessage: ChatMessage = {
      id: `msg_${timestamp}_user`,
      type: "user",
      content: query,
      timestamp: timestamp,
      cardIndex: -1,
      relatedTools: []
    }

    // Store bot response
    const botMessage: ChatMessage = {
      id: `msg_${timestamp}_bot`,
      type: "bot",
      content: response,
      timestamp: timestamp + 1,
      cardIndex: -1,
      relatedTools: ["intelligent_conversation"]
    }

    // Store in ChatStorage through StorageManager
    if (this.storageManager && this.storageManager.getChatStorage()) {
      const chatStorage = this.storageManager.getChatStorage()

      // Store user message
      chatStorage.addMessage({
        id: userMessage.id,
        type: "user",
        content: userMessage.content,
        timestamp: userMessage.timestamp,
        cardIndex: userMessage.cardIndex,
        relatedTools: userMessage.relatedTools
      })

      // Store bot response
      chatStorage.addMessage({
        id: botMessage.id,
        type: "bot",
        content: botMessage.content,
        timestamp: botMessage.timestamp,
        cardIndex: botMessage.cardIndex,
        relatedTools: botMessage.relatedTools
      })

      if (this.enableDebugLogging) {
        print(`AgentOrchestrator: 💾 Stored conversation in ChatStorage`)
      }
    }

    // Also store in memory system for backward compatibility
    if (this.memorySystem) {
      this.memorySystem.addChatMessage(userMessage)
      this.memorySystem.addChatMessage(botMessage)

      // Update system state
      this.systemState.chatHistory = this.memorySystem.getChatHistory()
      this.onSystemStateChanged.invoke(this.systemState)
    }
  }

  // ================================
  // Bridge Component Integration Methods
  // ================================

  /**
   * Called by ChatBridge to ensure summary layout connection
   */
  public ensureChatAgentSummaryConnection(): void {
    if (this.enableDebugLogging) {
      print("AgentOrchestrator: Ensuring ChatAgent summary layout connection")
    }

    // This method ensures the chat system can read summary context
    // Implementation depends on your specific summary layout structure
    if (this.summaryComponent) {
      if (this.enableDebugLogging) {
        print("AgentOrchestrator: Summary layout connection confirmed")
      }
    } else {
      if (this.enableDebugLogging) {
        print("AgentOrchestrator: Summary layout not assigned")
      }
    }
  }

  /**
   * Called by ChatBridge to ensure chat layout connection
   */
  public ensureChatAgentChatLayoutConnection(): void {
    if (this.enableDebugLogging) {
      print("AgentOrchestrator: Ensuring ChatAgent chat layout connection")
    }

    if (this.chatComponent) {
      if (this.enableDebugLogging) {
        print("AgentOrchestrator: Chat layout connection confirmed")
      }
    } else {
      if (this.enableDebugLogging) {
        print("AgentOrchestrator: Chat layout not assigned")
      }
    }
  }

  /**
   * Get OpenAI assistant for bridge components
   */
  public getOpenAIAssistant(): OpenAIAssistant {
    return this.openAIAssistant
  }

  /**
   * Get Gemini assistant for bridge components
   */
  public getGeminiAssistant(): GeminiAssistant {
    return this.geminiAssistant
  }

  // ================================
  // System Management
  // ================================

  public getSystemState(): SystemState {
    return this.systemState
  }

  public isSystemReady(): boolean {
    return this.initialized && this.enableSystem && !this.isProcessingQuery
  }

  /**
   * Abort the current in-progress query (OpenClaw mode).
   * Sends chat.abort and interrupts any ongoing audio output.
   */
  public abortCurrentQuery(): void {
    if (this.connectionMode === "openclaw" && this.openClawBridge?.isConnected()) {
      this.openClawBridge.abortQuery()
      print("AgentOrchestrator: Abort sent to OpenClaw")
    }

    // Interrupt native TTS playback
    this.stopNativeTTS()

    // Interrupt AI provider audio output
    if (this.languageInterface) {
      this.languageInterface.interruptAudioOutput()
    }

    this.isProcessingQuery = false
  }

  /**
   * Get current connection mode (openclaw or direct AI provider).
   */
  public getConnectionMode(): "direct" | "openclaw" {
    return this.connectionMode
  }

  /**
   * Get the OpenClaw bridge instance (if enabled).
   */
  public getOpenClawBridge(): OpenClawBridge | null {
    return this.openClawBridge
  }

  public resetSystem(): void {
    // Use StorageManager for centralized reset
    if (this.storageManager) {
      this.storageManager.resetAllStorage()
      if (this.enableDebugLogging) {
        print("AgentOrchestrator: Using StorageManager for system reset")
      }
    } else if (this.memorySystem) {
      // Fallback to old behavior if StorageManager not assigned
      this.memorySystem.clearStorage()
    }

    this.initializeSystemState()

    // FIX: Fire event to clear UI components
    this.onSystemReset.invoke()

    if (this.enableDebugLogging) {
      print("AgentOrchestrator: System reset completed")
    }
  }

  // ================================
  // Native TTS (Spectacles TextToSpeechModule)
  // ================================

  /**
   * Speak text using Spectacles native TextToSpeechModule.
   * Used in OpenClaw mode to avoid claiming the mic via AI provider sessions.
   */
  private speakNative(text: string): void {
    if (!text) return

    // Lazy-load TextToSpeechModule on first use (can't require at field-init time — component not yet awake)
    if (!this.ttsModule) {
      try {
        this.ttsModule = require("LensStudio:TextToSpeechModule")
        print("AgentOrchestrator: [NativeTTS] TextToSpeechModule loaded")
      } catch (e) {
        print(`AgentOrchestrator: [NativeTTS] Failed to load TextToSpeechModule: ${e}`)
        return
      }
    }

    print(`AgentOrchestrator: [NativeTTS] Speaking: "${text.substring(0, 50)}..."`)

    const options = TextToSpeech.Options.create()
    this.isSpeakingNative = true

    this.ttsModule.synthesize(
      text,
      options,
      (audioTrackAsset: AudioTrackAsset, wordInfo: TextToSpeech.WordInfo[], phonemeInfo: TextToSpeech.PhonemeInfo[], voiceStyle: any) => {
        if (this.ttsAudioComponent) {
          this.ttsAudioComponent.audioTrack = audioTrackAsset
          this.ttsAudioComponent.play(1)
          this.ttsAudioComponent.setOnFinish(() => {
            this.isSpeakingNative = false
            print("AgentOrchestrator: [NativeTTS] Playback finished")
          })
        } else {
          print("AgentOrchestrator: [NativeTTS] No AudioComponent assigned — cannot play audio")
          this.isSpeakingNative = false
        }
      },
      (error: number, description: string) => {
        print(`AgentOrchestrator: [NativeTTS] Error ${error}: ${description}`)
        this.isSpeakingNative = false
      }
    )
  }

  /**
   * Stop native TTS playback immediately.
   */
  private stopNativeTTS(): void {
    if (this.ttsAudioComponent && this.isSpeakingNative) {
      this.ttsAudioComponent.stop(false)
      this.isSpeakingNative = false
      print("AgentOrchestrator: [NativeTTS] Playback interrupted")
    }
  }

  // ================================
  // Tool Display Management
  // ================================

  private updateToolDisplay(query: string, result: any): void {
    if (!this.toolDisplayText) return

    try {
      let toolDisplay = "Unknown Tool"

      // Determine which tool was used based on the result
      if (result.success && result.result) {
        if (result.result.shouldCreateDiagram) {
          toolDisplay = "Diagram Tool"
        } else if (result.result.summaryFocused) {
          toolDisplay = "📚 Summary Tool"
        } else if (result.result.spatiallyAware || result.result.toolUsed === "spatial_tool") {
          toolDisplay = "Spatial Tool"
        } else {
          toolDisplay = "Default Conversation"
        }
      }

      // Simple display - just show the current tool
      this.toolDisplayText.text = toolDisplay

      if (this.enableDebugLogging && this.showQueryRouting) {
        print(`AgentOrchestrator: 📺 Tool selected: ${toolDisplay}`)
      }
    } catch (error) {
      if (this.enableDebugLogging) {
        print(`AgentOrchestrator: Failed to update tool display: ${error}`)
      }
    }
  }

  // ================================
  // Error Handling
  // ================================

  private handleError(error: string): void {
    print(`AgentOrchestrator: ${error}`)
    this.onError.invoke(error)

    // Update system state to reflect error
    if (this.systemState) {
      this.systemState.currentStep = "idle"
      this.onSystemStateChanged.invoke(this.systemState)
    }
  }
}
