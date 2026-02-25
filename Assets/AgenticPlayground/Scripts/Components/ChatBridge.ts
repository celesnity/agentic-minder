import Event from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {AgentOrchestrator} from "../Agents/AgentOrchestrator"
import {ChatMessage} from "../Agents/AgentTypes"
import {OpenClawBridge} from "../Bridge/OpenClawBridge"
import {OpenClawStreamingDelta} from "../Bridge/OpenClawTypes"
import {ChatStorage} from "../Storage/ChatStorage"
import {ChatExtensions} from "../Utils/ChatExtensions"
import {CHARACTER_LIMITS, TextLimiter} from "../Utils/TextLimiter"
import {ChatComponent} from "./ChatComponent"

/**
 * ChatBridge - Bridge between AgentOrchestrator and ChatComponent
 *
 * According to architecture diagram, this handles the agentic chat flow:
 * AgentOrchestrator → Tools → ChatStorage → ChatBridge → ChatComponent
 *
 * This simplified version uses only confirmed existing APIs.
 */
@component
export class ChatBridge extends BaseScriptComponent {
  @input
  @hint("Reference to AgentOrchestrator component")
  agentOrchestrator: AgentOrchestrator = null

  @input
  @hint("Reference to ChatStorage component")
  chatStorage: ChatStorage = null

  @input
  @hint("Reference to ChatComponent for UI display")
  chatLayout: ChatComponent = null

  @input enableDebugLogging: boolean = true
  @input maxDisplayMessages: number = 50

  @input
  @hint("Reference to ChatASRController for partial transcription display (optional)")
  @allowUndefined
  chatASRController: any

  private isConnected: boolean = false
  private lastMessageCount: number = 0
  private connectionRetryCount: number = 0
  private readonly MAX_CONNECTION_RETRIES: number = 10

  // Streaming state for progressive UI display
  private streamingCardIndex: number = -1
  private isStreamingResponse: boolean = false
  private streamingDidDisplay: boolean = false

  // Partial transcription state for always-on mode
  private partialCardIndex: number = -1
  private hasPartialCard: boolean = false

  public onMessageDisplayed: Event<ChatMessage> = new Event<ChatMessage>()
  public onError: Event<string> = new Event<string>()

  onAwake() {
    this.createEvent("OnStartEvent").bind(this.initialize.bind(this))
    this.createEvent("UpdateEvent").bind(this.checkForUpdates.bind(this))

    if (this.enableDebugLogging) {
      print("ChatBridge: 🌉 Chat bridge component awakened")
    }
  }

  private initialize(): void {
    this.validateComponents()
    this.setupConnections()
    this.loadExistingHistory()

    if (this.enableDebugLogging) {
      print("ChatBridge: Initialized successfully")
    }
  }

  private validateComponents(): void {
    if (!this.agentOrchestrator) {
      print("ChatBridge: AgentOrchestrator not assigned")
      return
    }

    if (!this.chatStorage) {
      print("ChatBridge: ChatStorage not assigned")
      return
    }

    if (!this.chatLayout) {
      print("ChatBridge: ChatLayout not assigned")
      return
    }
  }

  private setupConnections(): void {
    // Connect to AgentOrchestrator events
    if (this.agentOrchestrator) {
      // Check if events exist before subscribing
      if (this.agentOrchestrator.onQueryProcessed && this.agentOrchestrator.onQueryProcessed.add) {
        this.agentOrchestrator.onQueryProcessed.add((data) => {
          this.handleNewConversation(data.query, data.response)
        })

        if (this.enableDebugLogging) {
          print("ChatBridge: Connected to AgentOrchestrator.onQueryProcessed")
        }
      } else {
        print("ChatBridge: AgentOrchestrator.onQueryProcessed not available yet")
      }

      if (this.agentOrchestrator.onError && this.agentOrchestrator.onError.add) {
        this.agentOrchestrator.onError.add((error) => {
          this.handleOrchestratorError(error)
        })

        if (this.enableDebugLogging) {
          print("ChatBridge: Connected to AgentOrchestrator.onError")
        }
      } else {
        print("ChatBridge: AgentOrchestrator.onError not available yet")
      }

      // FIX: Listen to system reset events to clear chat UI
      if (this.agentOrchestrator.onSystemReset && this.agentOrchestrator.onSystemReset.add) {
        this.agentOrchestrator.onSystemReset.add(() => {
          this.clearChatUI()
        })

        if (this.enableDebugLogging) {
          print("ChatBridge: Connected to AgentOrchestrator.onSystemReset")
        }
      } else {
        print("ChatBridge: AgentOrchestrator.onSystemReset not available yet")
      }

      // FIX: Connect to voice completion event for proper text display timing
      if (this.agentOrchestrator.onVoiceCompleted && this.agentOrchestrator.onVoiceCompleted.add) {
        this.agentOrchestrator.onVoiceCompleted.add((data) => {
          if (this.enableDebugLogging) {
            print(
              `ChatBridge: Received voice completion event - query: "${data.query?.substring(0, 30)}...", response: "${data.response?.substring(0, 30)}..." (${data.response?.length} chars)`
            )
          }
          this.handleVoiceCompleted(data.query, data.response)
        })

        if (this.enableDebugLogging) {
          print("ChatBridge: Connected to AgentOrchestrator.onVoiceCompleted")
        }
      } else {
        print("ChatBridge: AgentOrchestrator.onVoiceCompleted not available yet")
      }
    }

    // Connect to OpenClaw streaming delta for progressive UI
    this.subscribeToStreamingDelta()

    // Connect to ChatASRController for partial transcription display (always-on mode)
    if (this.chatASRController && this.chatASRController.onPartialTranscription) {
      this.chatASRController.onPartialTranscription.add((partialText: string) => {
        this.handlePartialTranscription(partialText)
      })
      if (this.enableDebugLogging) {
        print("ChatBridge: Connected to ChatASRController.onPartialTranscription")
      }
    }

    // Connect to ChatStorage events
    if (this.chatStorage) {
      // FIX: Disable ChatStorage.onMessageAdded to prevent duplicate messages
      // Since we're now displaying messages directly in handleNewConversation,
      // we don't need to listen to storage events which were causing duplicates
      if (this.enableDebugLogging) {
        print("ChatBridge: ChatStorage.onMessageAdded disabled to prevent duplicates")
      }
    }

    this.isConnected = true

    if (this.enableDebugLogging) {
      print("ChatBridge: Bridge connections established")
    }
  }

  private streamingDeltaSubscribed: boolean = false

  /**
   * Subscribe to OpenClaw streaming delta events.
   * Called during init and retried on each update tick until successful,
   * because the bridge may not be ready yet when ChatBridge initializes.
   */
  private subscribeToStreamingDelta(): void {
    if (this.streamingDeltaSubscribed) return
    if (!this.agentOrchestrator) return

    const bridge = this.agentOrchestrator.getOpenClawBridge()
    if (bridge) {
      bridge.onStreamingDelta.add((data: OpenClawStreamingDelta) => {
        this.handleStreamingDelta(data)
      })
      this.streamingDeltaSubscribed = true

      if (this.enableDebugLogging) {
        print("ChatBridge: Connected to OpenClawBridge.onStreamingDelta")
      }
    } else if (this.enableDebugLogging) {
      print("ChatBridge: OpenClawBridge not ready yet, will retry")
    }
  }

  /**
   * Retry connection setup if not all events are connected
   */
  private retryConnectionSetup(): void {
    if (this.isConnected || this.connectionRetryCount >= this.MAX_CONNECTION_RETRIES) {
      return
    }

    this.connectionRetryCount++

    if (this.enableDebugLogging) {
      print(
        `ChatBridge: Retrying connection setup (attempt ${this.connectionRetryCount}/${this.MAX_CONNECTION_RETRIES})`
      )
    }

    let connectionsNeeded = 0
    let connectionsEstablished = 0

    // Check AgentOrchestrator connections
    if (this.agentOrchestrator) {
      connectionsNeeded += 2 // onQueryProcessed and onError

      if (this.agentOrchestrator.onQueryProcessed && this.agentOrchestrator.onQueryProcessed.add) {
        connectionsEstablished++
      } else if (this.agentOrchestrator.onQueryProcessed && !this.agentOrchestrator.onQueryProcessed.add) {
        // Event exists but doesn't have add method yet
        print("ChatBridge: AgentOrchestrator.onQueryProcessed exists but no add method")
      }

      if (this.agentOrchestrator.onError && this.agentOrchestrator.onError.add) {
        connectionsEstablished++
      }
    }

    // Check ChatStorage connections
    if (this.chatStorage) {
      // FIX: onMessageAdded disabled to prevent duplicates
      // connectionsNeeded += 1; // onMessageAdded
      // if (this.chatStorage.onMessageAdded && this.chatStorage.onMessageAdded.add) {
      //   connectionsEstablished++
      // }
    }

    if (connectionsEstablished === connectionsNeeded && connectionsNeeded > 0) {
      // All required connections are now available, redo setup
      this.setupConnections()
    }
  }

  /**
   * Handle new conversation from AgentOrchestrator
   */
  private handleNewConversation(query: string, response: string): void {
    // FIX: Don't store messages here - AgentOrchestrator already stores them in memory
    // This was causing duplicate messages because ChatStorage.onMessageAdded would trigger displays
    // Let's just display the messages directly instead of storing them again

    const timestamp = Date.now()

    // Create user message using correct character limit
    const userMessage: ChatMessage = {
      id: `msg_${timestamp}_user`,
      type: "user",
      content: TextLimiter.limitText(query, CHARACTER_LIMITS.USER_CARD_TEXT),
      timestamp: timestamp,
      cardIndex: -1,
      relatedTools: []
    }

    // Remove partial transcription card if it exists (replaced by final text)
    this.clearPartialCard()

    // Display user message immediately
    this.displayMessage(userMessage)

    // FIX: Check if voice output is enabled
    const isVoiceEnabled = this.agentOrchestrator && this.agentOrchestrator.enableVoiceOutput

    // Check if OpenClaw streaming already created the bot card
    const isOpenClawMode = this.agentOrchestrator && this.agentOrchestrator.getConnectionMode() === "openclaw"
    // Only skip display if streaming actually ran and displayed the card
    const streamingAlreadyDisplayed = isOpenClawMode && this.streamingDidDisplay

    if (isVoiceEnabled && response === "") {
      // Voice mode with empty response - wait for transcription
      if (this.enableDebugLogging) {
        print(`ChatBridge: Voice mode detected - waiting for transcription event`)
      }
      // Don't display anything - wait for voice completion event
    } else if (streamingAlreadyDisplayed && response && response.length > 0) {
      // OpenClaw mode with streaming complete — bot card was already created by handleStreamingDelta
      if (this.enableDebugLogging) {
        print(`ChatBridge: Skipping bot card — already displayed via streaming`)
      }
      // Reset the flag for next query
      this.streamingDidDisplay = false
    } else if (response && response.length > 0) {
      // We have a text response - display it (direct mode or no streaming)
      const botMessage: ChatMessage = {
        id: `msg_${timestamp + 1}_bot`,
        type: "bot",
        content: TextLimiter.limitText(response, CHARACTER_LIMITS.BOT_CARD_TEXT),
        timestamp: timestamp + 1,
        cardIndex: -1,
        relatedTools: ["intelligent_conversation"]
      }

      this.displayMessage(botMessage)

      if (this.enableDebugLogging) {
        print(`ChatBridge: Bot message displayed: "${response.substring(0, 50)}..."`)
      }
    }

    if (this.enableDebugLogging) {
      print(`ChatBridge: New conversation handled: "${query.substring(0, 50)}..." (voice: ${isVoiceEnabled})`)
    }
  }

  /**
   * Handle streaming delta from OpenClaw for progressive UI updates
   */
  private handleStreamingDelta(data: OpenClawStreamingDelta): void {
    if (!this.chatLayout) return

    if (!this.isStreamingResponse && data.accumulated.length > 0) {
      // First delta — create a placeholder bot card
      const added = ChatExtensions.addBotCard(this.chatLayout, data.accumulated)
      if (added) {
        this.streamingCardIndex = ChatExtensions.getCardCount(this.chatLayout) - 1
        this.isStreamingResponse = true

        if (this.enableDebugLogging) {
          print("ChatBridge: Streaming started, card index: " + this.streamingCardIndex)
        }
      }
    } else if (this.isStreamingResponse && this.streamingCardIndex >= 0) {
      // Subsequent deltas — update the card text in-place
      const limited = TextLimiter.limitText(data.accumulated, CHARACTER_LIMITS.BOT_CARD_TEXT)
      ChatExtensions.updateBotCardText(this.chatLayout, this.streamingCardIndex, limited)
    }

    if (data.done) {
      // Finalize: update with final text and reset streaming state
      if (this.isStreamingResponse && this.streamingCardIndex >= 0) {
        const finalText = TextLimiter.limitText(data.accumulated, CHARACTER_LIMITS.BOT_CARD_TEXT)
        ChatExtensions.updateBotCardText(this.chatLayout, this.streamingCardIndex, finalText)
        this.streamingDidDisplay = true

        if (this.enableDebugLogging) {
          print("ChatBridge: Streaming complete, final length: " + data.accumulated.length)
        }
      }

      this.isStreamingResponse = false
      this.streamingCardIndex = -1
    }
  }

  /**
   * Handle partial transcription from always-on ASR mode.
   * Shows a temporary user card with real-time transcription text.
   */
  private handlePartialTranscription(partialText: string): void {
    if (!this.chatLayout || !partialText || partialText.trim().length === 0) return

    const displayText = partialText.trim() + "..."

    if (!this.hasPartialCard) {
      const added = ChatExtensions.addUserCard(this.chatLayout, displayText)
      if (added) {
        this.partialCardIndex = ChatExtensions.getCardCount(this.chatLayout) - 1
        this.hasPartialCard = true
      }
    } else if (this.partialCardIndex >= 0) {
      // Update the existing partial card text in-place
      ChatExtensions.updateUserCardText(this.chatLayout, this.partialCardIndex, displayText)
    }
  }

  /**
   * Remove the partial transcription card (called when final text arrives).
   */
  private clearPartialCard(): void {
    if (!this.hasPartialCard || this.partialCardIndex < 0 || !this.chatLayout) {
      this.hasPartialCard = false
      this.partialCardIndex = -1
      return
    }

    try {
      ChatExtensions.removeCard(this.chatLayout, this.partialCardIndex)
    } catch (_e) {
      // Silent fail for UI cleanup
    }

    this.hasPartialCard = false
    this.partialCardIndex = -1
  }

  /**
   * Handle new message from ChatStorage
   */
  private handleNewMessage(message: ChatMessage): void {
    this.displayMessage(message)
    this.onMessageDisplayed.invoke(message)
  }

  /**
   * Handle voice completion - display the bot message with transcription
   * FIX: This displays the bot card after voice completes with the actual transcription
   */
  private handleVoiceCompleted(query: string, response: string): void {
    if (this.enableDebugLogging) {
      print(
        `ChatBridge: Voice completed with transcription: "${response.substring(0, 50)}..." (${response.length} chars)`
      )
    }

    // Create bot message with the transcription
    const botMessage: ChatMessage = {
      id: `msg_${Date.now()}_bot`,
      type: "bot",
      content: TextLimiter.limitText(response, CHARACTER_LIMITS.BOT_CARD_TEXT),
      timestamp: Date.now(),
      cardIndex: -1,
      relatedTools: ["intelligent_conversation"]
    }

    // Display the bot message
    this.displayMessage(botMessage)

    if (this.enableDebugLogging) {
      print(`ChatBridge: Bot message displayed with transcription after voice completion`)
    }
  }

  /**
   * Display message in chat UI using existing ChatExtensions
   */
  private displayMessage(message: ChatMessage): void {
    if (!this.chatLayout) return

    try {
      // Use existing ChatExtensions methods that actually exist
      if (message.type === "user") {
        ChatExtensions.addUserCard(this.chatLayout, message.content)
      } else {
        ChatExtensions.addBotCard(this.chatLayout, message.content)
      }

      if (this.enableDebugLogging) {
        print(`ChatBridge: Displayed ${message.type} message: "${message.content.substring(0, 30)}..."`)
      }
    } catch (error) {
      print(`ChatBridge: Failed to display message: ${error}`)
      this.onError.invoke(`Message display failed: ${error}`)
    }
  }

  /**
   * Clear all chat UI (called when storage is reset)
   */
  public clearChatUI(): void {
    if (this.chatLayout) {
      const success = ChatExtensions.clearAllCards(this.chatLayout)
      if (this.enableDebugLogging) {
        print(`ChatBridge: ${success ? "" : ""} Chat UI cleared`)
      }
    }
  }

  /**
   * Load existing chat history from AgentOrchestrator memory system
   * FIX: No longer loads from ChatStorage to prevent disconnect with AgentOrchestrator's memory
   */
  private loadExistingHistory(): void {
    if (!this.agentOrchestrator || !this.chatLayout) return

    try {
      // FIX: Try to get chat history from AgentOrchestrator's memory system
      // AgentOrchestrator stores messages in AgentMemorySystem, not ChatStorage
      // For now, skip history loading on startup since messages will flow through
      // the proper onQueryProcessed event system going forward

      if (this.enableDebugLogging) {
        print("ChatBridge: 📚 History loading disabled - messages flow through AgentOrchestrator events")
      }
    } catch (error) {
      print(`ChatBridge: Failed to load history: ${error}`)
    }
  }

  /**
   * Retry connections if needed (periodic check for message updates removed)
   * FIX: No longer polls ChatStorage since messages flow through AgentOrchestrator events
   */
  private checkForUpdates(): void {
    // Retry connections if not fully established
    if (!this.isConnected) {
      this.retryConnectionSetup()
    }

    // Retry streaming delta subscription until the bridge is ready
    if (!this.streamingDeltaSubscribed) {
      this.subscribeToStreamingDelta()
    }
  }

  /**
   * Handle orchestrator errors
   */
  private handleOrchestratorError(error: string): void {
    print(`ChatBridge: Orchestrator error: ${error}`)
    this.onError.invoke(error)

    // Display error message in chat
    const errorMessage: ChatMessage = {
      id: `error_${Date.now()}`,
      type: "bot",
      content: `System Error: ${error}`,
      timestamp: Date.now(),
      cardIndex: -1,
      relatedTools: []
    }

    this.displayMessage(errorMessage)
  }

  // ================================
  // Public API
  // ================================

  /**
   * Force refresh chat display
   */
  public refreshChatDisplay(): void {
    this.loadExistingHistory()
  }

  /**
   * Clear all chat messages using AgentOrchestrator reset
   * FIX: Use AgentOrchestrator.resetSystem() instead of ChatStorage
   */
  public clearAllMessages(): void {
    if (this.agentOrchestrator) {
      this.agentOrchestrator.resetSystem()
    }

    if (this.enableDebugLogging) {
      print("ChatBridge: All messages cleared via AgentOrchestrator")
    }
  }

  /**
   * Get current bridge status
   */
  public getBridgeStatus(): {
    isConnected: boolean
    messageCount: number
    hasValidComponents: boolean
  } {
    return {
      isConnected: this.isConnected,
      messageCount: this.lastMessageCount,
      hasValidComponents: !!(this.agentOrchestrator && this.chatStorage && this.chatLayout)
    }
  }

  /**
   * Send manual message (for testing) through AgentOrchestrator flow
   * FIX: Use AgentOrchestrator.processUserQuery() instead of direct ChatStorage
   */
  public async sendTestMessage(content: string, isUser: boolean = true): Promise<void> {
    if (!this.agentOrchestrator || !isUser) {
      // Only support user test messages since bot responses come from AI
      if (this.enableDebugLogging) {
        print("ChatBridge: Test messages must be user messages and require AgentOrchestrator")
      }
      return
    }

    try {
      // Send through proper flow: AgentOrchestrator → onQueryProcessed → handleNewConversation
      await this.agentOrchestrator.processUserQuery(content)

      if (this.enableDebugLogging) {
        print(`ChatBridge: Test message sent through AgentOrchestrator: "${content}"`)
      }
    } catch (error) {
      print(`ChatBridge: Test message failed: ${error}`)
    }
  }
}
