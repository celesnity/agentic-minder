import Event from "SpectaclesInteractionKit.lspkg/Utils/Event"
import {OpenClawStreamingDelta} from "../Bridge/OpenClawTypes"
import {JarvisController} from "../JarvisController"
import {ChatExtensions} from "../Utils/ChatExtensions"
import {CHARACTER_LIMITS, TextLimiter} from "../Utils/TextLimiter"
import {ChatComponent} from "./ChatComponent"

/**
 * ChatMessage — lightweight type for display purposes.
 * Replaces the old import from AgentTypes.
 */
interface ChatMessage {
  id: string
  type: "user" | "bot"
  content: string
  timestamp: number
  cardIndex: number
}

/**
 * ChatBridge - Bridge between JarvisController and ChatComponent
 *
 * Handles the chat display flow:
 * JarvisController → ChatBridge → ChatComponent
 */
@component
export class ChatBridge extends BaseScriptComponent {
  @input
  @hint("Reference to JarvisController component")
  @allowUndefined
  jarvisController: JarvisController

  @input
  @hint("Reference to ChatComponent for UI display")
  @allowUndefined
  chatLayout: ChatComponent

  @input enableDebugLogging: boolean = true

  @input
  @hint("Reference to ChatASRController for partial transcription display (optional)")
  @allowUndefined
  chatASRController: any

  private isConnected: boolean = false
  private connectionRetryCount: number = 0
  private readonly MAX_CONNECTION_RETRIES: number = 10

  // Streaming state for progressive UI display
  private streamingCardIndex: number = -1
  private isStreamingResponse: boolean = false
  private streamingDidDisplay: boolean = false

  // Partial transcription state for always-on mode
  private partialCardIndex: number = -1
  private hasPartialCard: boolean = false

  public onError: Event<string> = new Event<string>()

  onAwake() {
    this.createEvent("OnStartEvent").bind(this.initialize.bind(this))
    this.createEvent("UpdateEvent").bind(this.checkForUpdates.bind(this))

    if (this.enableDebugLogging) {
      print("ChatBridge: Chat bridge component awakened")
    }
  }

  private initialize(): void {
    this.validateComponents()
    this.setupConnections()

    if (this.enableDebugLogging) {
      print("ChatBridge: Initialized successfully")
    }
  }

  private validateComponents(): void {
    if (!this.jarvisController) {
      print("ChatBridge: JarvisController not assigned")
      return
    }

    if (!this.chatLayout) {
      print("ChatBridge: ChatLayout not assigned")
      return
    }
  }

  private setupConnections(): void {
    if (this.jarvisController) {
      // Subscribe to query processed events
      if (this.jarvisController.onQueryProcessed && this.jarvisController.onQueryProcessed.add) {
        this.jarvisController.onQueryProcessed.add((data) => {
          this.handleNewConversation(data.query, data.response)
        })

        if (this.enableDebugLogging) {
          print("ChatBridge: Connected to JarvisController.onQueryProcessed")
        }
      } else {
        print("ChatBridge: JarvisController.onQueryProcessed not available yet")
      }

      // Subscribe to error events
      if (this.jarvisController.onError && this.jarvisController.onError.add) {
        this.jarvisController.onError.add((error) => {
          this.handleError(error)
        })

        if (this.enableDebugLogging) {
          print("ChatBridge: Connected to JarvisController.onError")
        }
      }

      // Subscribe to streaming delta for progressive UI
      this.subscribeToStreamingDelta()
    }

    // Connect to ChatASRController for partial transcription display (always-on mode)
    if (this.chatASRController && this.chatASRController.onPartialTranscription) {
      this.chatASRController.onPartialTranscription.add((partialText: string) => {
        this.handlePartialTranscription(partialText)
      })
      if (this.enableDebugLogging) {
        print("ChatBridge: Connected to ChatASRController.onPartialTranscription")
      }
    }

    this.isConnected = true

    if (this.enableDebugLogging) {
      print("ChatBridge: Bridge connections established")
    }
  }

  private streamingDeltaSubscribed: boolean = false

  /**
   * Subscribe to OpenClaw streaming delta events via JarvisController.
   * Retried on each update tick until successful.
   */
  private subscribeToStreamingDelta(): void {
    if (this.streamingDeltaSubscribed) return
    if (!this.jarvisController) return

    // JarvisController re-emits streaming deltas from the bridge
    if (this.jarvisController.onStreamingDelta && this.jarvisController.onStreamingDelta.add) {
      this.jarvisController.onStreamingDelta.add((data: OpenClawStreamingDelta) => {
        this.handleStreamingDelta(data)
      })
      this.streamingDeltaSubscribed = true

      if (this.enableDebugLogging) {
        print("ChatBridge: Connected to JarvisController.onStreamingDelta")
      }
    } else if (this.enableDebugLogging) {
      print("ChatBridge: JarvisController.onStreamingDelta not ready yet, will retry")
    }
  }

  /**
   * Retry connection setup if not all events are connected.
   */
  private retryConnectionSetup(): void {
    if (this.isConnected || this.connectionRetryCount >= this.MAX_CONNECTION_RETRIES) {
      return
    }

    this.connectionRetryCount++

    if (this.jarvisController &&
        this.jarvisController.onQueryProcessed &&
        this.jarvisController.onQueryProcessed.add) {
      this.setupConnections()
    }
  }

  /**
   * Handle new conversation from JarvisController.
   */
  private handleNewConversation(query: string, response: string): void {
    const timestamp = Date.now()

    // Create user message
    const userMessage: ChatMessage = {
      id: `msg_${timestamp}_user`,
      type: "user",
      content: TextLimiter.limitText(query, CHARACTER_LIMITS.USER_CARD_TEXT),
      timestamp: timestamp,
      cardIndex: -1
    }

    // Remove partial transcription card if it exists (replaced by final text)
    this.clearPartialCard()

    // Display user message immediately
    this.displayMessage(userMessage)

    // Check if streaming already created the bot card
    const streamingAlreadyDisplayed = this.streamingDidDisplay

    if (streamingAlreadyDisplayed && response && response.length > 0) {
      // Bot card was already created by handleStreamingDelta
      if (this.enableDebugLogging) {
        print("ChatBridge: Skipping bot card — already displayed via streaming")
      }
      this.streamingDidDisplay = false
    } else if (response && response.length > 0) {
      // Display bot response
      const botMessage: ChatMessage = {
        id: `msg_${timestamp + 1}_bot`,
        type: "bot",
        content: TextLimiter.limitText(response, CHARACTER_LIMITS.BOT_CARD_TEXT),
        timestamp: timestamp + 1,
        cardIndex: -1
      }

      this.displayMessage(botMessage)

      if (this.enableDebugLogging) {
        print(`ChatBridge: Bot message displayed: "${response.substring(0, 50)}..."`)
      }
    }

    if (this.enableDebugLogging) {
      print(`ChatBridge: Conversation handled: "${query.substring(0, 50)}..."`)
    }
  }

  /**
   * Handle streaming delta from OpenClaw for progressive UI updates.
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
   * Display message in chat UI using ChatExtensions.
   */
  private displayMessage(message: ChatMessage): void {
    if (!this.chatLayout) return

    try {
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
   * Clear all chat UI.
   */
  public clearChatUI(): void {
    if (this.chatLayout) {
      ChatExtensions.clearAllCards(this.chatLayout)
      if (this.enableDebugLogging) {
        print("ChatBridge: Chat UI cleared")
      }
    }
  }

  /**
   * Retry connections if needed.
   */
  private checkForUpdates(): void {
    if (!this.isConnected) {
      this.retryConnectionSetup()
    }

    if (!this.streamingDeltaSubscribed) {
      this.subscribeToStreamingDelta()
    }
  }

  /**
   * Handle errors from JarvisController.
   */
  private handleError(error: string): void {
    print(`ChatBridge: Error: ${error}`)
    this.onError.invoke(error)

    const errorMessage: ChatMessage = {
      id: `error_${Date.now()}`,
      type: "bot",
      content: `Error: ${error}`,
      timestamp: Date.now(),
      cardIndex: -1
    }

    this.displayMessage(errorMessage)
  }

  // ================================
  // Public API
  // ================================

  public clearAllMessages(): void {
    this.clearChatUI()

    if (this.enableDebugLogging) {
      print("ChatBridge: All messages cleared")
    }
  }

  public getBridgeStatus(): {
    isConnected: boolean
    hasValidComponents: boolean
  } {
    return {
      isConnected: this.isConnected,
      hasValidComponents: !!(this.jarvisController && this.chatLayout)
    }
  }

  public async sendTestMessage(content: string): Promise<void> {
    if (!this.jarvisController) {
      if (this.enableDebugLogging) {
        print("ChatBridge: Test messages require JarvisController")
      }
      return
    }

    try {
      await this.jarvisController.processQuery(content)

      if (this.enableDebugLogging) {
        print(`ChatBridge: Test message sent: "${content}"`)
      }
    } catch (error) {
      print(`ChatBridge: Test message failed: ${error}`)
    }
  }
}
