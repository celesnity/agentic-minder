import { AgentLanguageInterface } from "../Agents/AgentLanguageInterface"
import { SummaryStorage } from "../Storage/SummaryStorage"
import { RemoteVectorMemoryClient } from "../Storage/RemoteVectorMemoryClient"
import { CHARACTER_LIMITS, TextLimiter } from "../Utils/TextLimiter"

/**
 * Default conversation tool for normal chat when no specific tool is needed
 * Provides AI-powered responses for general questions and conversation
 * NOW WITH ACCESS TO SUMMARY STORAGE + VECTORDB FOR FULL CONTEXT
 */
export class GeneralConversationTool {
  public readonly name = "general_conversation"
  public readonly description = "Handles general conversation and questions using AI with access to lecture summaries and VectorDB recordings"

  public readonly parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "The user query to respond to" },
      maxLength: {
        type: "number",
        description: "Maximum character length for the response",
        default: CHARACTER_LIMITS.BOT_CARD_TEXT
      },
      conversational: { type: "boolean", description: "Whether to use conversational tone", default: true },
      educationalFocus: { type: "boolean", description: "Whether to maintain educational focus", default: true }
    },
    required: ["query"]
  }

  private languageInterface: AgentLanguageInterface
  private summaryStorage: SummaryStorage | null = null
  private vectorClient: RemoteVectorMemoryClient | null = null

  constructor(languageInterface: AgentLanguageInterface) {
    this.languageInterface = languageInterface
    print("GeneralConversationTool: Default conversation handler initialized")
  }

  /**
   * Set the summary storage component for retrieving lecture content
   */
  public setSummaryStorage(summaryStorage: SummaryStorage): void {
    this.summaryStorage = summaryStorage
    print("GeneralConversationTool: ✅ Connected to SummaryStorage")
  }

  /**
   * Set the RemoteVectorMemoryClient for searching recorded transcripts
   */
  public setVectorClient(client: RemoteVectorMemoryClient): void {
    this.vectorClient = client
    print("GeneralConversationTool: ✅ Connected to VectorDB client")
  }

  public async execute(args: Record<string, unknown>): Promise<{ success: boolean; result?: any; error?: string }> {
    const { query } = args

    if (!query || typeof query !== "string") {
      return { success: false, error: "Query parameter is required and must be a string" }
    }

    return await this.generateConversationalResponse(args)
  }

  /**
   * Generate conversational response using AI with lecture context from storage
   */
  private async generateConversationalResponse(
    args: Record<string, unknown>
  ): Promise<{ success: boolean; result?: any; error?: string }> {
    const {
      query,
      summaryContext,
      retrievalContext,
      maxLength = CHARACTER_LIMITS.BOT_CARD_TEXT,
      conversational = true,
      educationalFocus = true
    } = args

    print(`GeneralConversationTool: Generating conversational response for: "${(query as string).substring(0, 50)}..."`)

    // NEW: Get lecture context directly from SummaryStorage
    let lectureContext: any = null
    if (this.summaryStorage) {
      const currentSummary = this.summaryStorage.getCurrentSummary()
      if (currentSummary && currentSummary.sections && currentSummary.sections.length > 0) {
        lectureContext = {
          summaries: currentSummary.sections,
          title: currentSummary.summaryTitle,
          originalText: currentSummary.originalText
        }
        print(`GeneralConversationTool: 📚 ✅ LOADED ${currentSummary.sections.length} lecture sections from SummaryStorage`)
        print(`GeneralConversationTool: 📝 Lecture title: "${currentSummary.summaryTitle}"`)
        print(`GeneralConversationTool: 📄 First section: "${currentSummary.sections[0]?.title || 'N/A'}"`)
      } else {
        print(`GeneralConversationTool: ⚠️ SummaryStorage connected but no summaries available`)
      }
    } else {
      print(`GeneralConversationTool: ❌ SummaryStorage NOT connected - cannot access lecture data`)
    }

    // NEW: Search VectorDB for relevant recorded content
    let vectorContext: string = ""
    if (this.vectorClient) {
      try {
        print(`GeneralConversationTool: 🔍 Searching VectorDB for context related to: "${(query as string).substring(0, 50)}..."`)
        const matches = await this.vectorClient.search(query as string, 3) // Get top 3 matches
        
        if (matches && matches.length > 0) {
          print(`GeneralConversationTool: ✅ Found ${matches.length} relevant chunks in VectorDB`)
          vectorContext = "\n\nRELEVANT RECORDED CONTENT FROM YOUR PAST RECORDINGS:\n"
          matches.forEach((match, index) => {
            vectorContext += `\n[Recording ${index + 1}, Relevance: ${(match.score * 100).toFixed(0)}%]\n${match.text}\n`
            print(`GeneralConversationTool: 📄 Match ${index + 1} - Score: ${match.score.toFixed(2)} - Preview: "${match.text.substring(0, 50)}..."`)
          })
        } else {
          print(`GeneralConversationTool: ℹ️ No relevant recordings found in VectorDB`)
        }
      } catch (error) {
        print(`GeneralConversationTool: ⚠️ VectorDB search failed: ${error}`)
      }
    } else {
      print(`GeneralConversationTool: ℹ️ VectorDB client not connected - skipping recording search`)
    }

    // Fallback to summaryContext parameter if no storage available
    const context = lectureContext || (summaryContext as any)

    // Enhanced logging for context verification
    if (context && context.summaries && Array.isArray(context.summaries)) {
      print(`GeneralConversationTool: 📚 REAL lecture context available: ${context.summaries.length} sections`)
      print(`GeneralConversationTool: 📋 First section title: "${context.summaries[0]?.title || 'N/A'}"`)
      print(`GeneralConversationTool: 📝 Context will be injected into Gemini prompt`)
    } else {
      print(`GeneralConversationTool: ⚠️ NO lecture context - Gemini will NOT have access to lecture data`)
      print(`GeneralConversationTool: ℹ️ Using general conversation mode only`)
    }

    // Ensure maxLength is valid
    const validMaxLength = (maxLength as number) > 0 ? (maxLength as number) : CHARACTER_LIMITS.BOT_CARD_TEXT

    try {
      // Build system prompt with lecture context injection (REAL DATA)
      let systemPrompt = `You are a helpful and friendly AI assistant with a focus on educational support.`

      // Inject VectorDB search results (most relevant recorded content)
      if (vectorContext && vectorContext.trim().length > 0) {
        systemPrompt += `\n\n${vectorContext.trim()}\n`
        systemPrompt += `IMPORTANT: Use these recordings to answer the user's question. These are actual transcripts from their past recordings that are most relevant to their query.\n`
      }

      // Inject vector retrieval context (latest recorded transcript excerpts) - legacy support
      if (retrievalContext && typeof retrievalContext === "string" && retrievalContext.trim().length > 0) {
        systemPrompt += `\n\n${retrievalContext.trim()}\n`
        systemPrompt += `IMPORTANT: If the user references "the video", "what I just watched", or asks follow-ups, use these excerpts as context.\n`
      }

      // Inject REAL lecture context if available
      if (context && context.summaries && Array.isArray(context.summaries)) {
        systemPrompt += `\n\nLECTURE CONTEXT (Real captured data):\n`
        systemPrompt += `You have access to content from a lecture/video the user just watched:\n\n`
        
        context.summaries.forEach((summary: any, index: number) => {
          if (summary.title && summary.content) {
            systemPrompt += `Section ${index + 1}: ${summary.title}\n`
            systemPrompt += `${summary.content}\n\n`
          }
        })
        
        systemPrompt += `IMPORTANT: When the user asks about "the video", "the lecture", or "what I watched/learned", reference this context directly. Answer as if you watched it with them.\n\n`
      }

      systemPrompt += `

RESPONSE REQUIREMENTS:
- Your responses MUST be limited to exactly ${validMaxLength} characters or fewer
- This is a HARD LIMIT that cannot be exceeded under any circumstances
- Be conversational, friendly, and helpful
${educationalFocus ? "- Maintain an educational focus when appropriate" : ""}
- Use a natural, engaging tone
- If the question is very general (like greetings), offer to help with specific topics

CONVERSATION STYLE:
- Be warm and approachable
- Ask follow-up questions to better assist the user
- Provide helpful suggestions when appropriate
- Keep responses concise but informative within the character limit

Remember: Be helpful, friendly, and educational while staying within the ${validMaxLength} character limit.`

      // Call the AI with the conversational system prompt
      // FIX: Force textOnly: true to use Models API for reliable text response
      // Audio output will be handled by AgentOrchestrator's speak() method (re-injection)
      const response = await this.languageInterface.generateResponse(
        [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: query as string
          }
        ],
        {
          temperature: 0.8, // Slightly higher for more natural conversation
          maxTokens: Math.floor(validMaxLength / 2),
          textOnly: true // Force text mode for reliable response
        }
      )

      print("GeneralConversationTool: Conversational response requested (Text-First Mode)")

      // Extract content from LLMResponse object
      const responseContent = response?.content || ""

      if (!responseContent || responseContent.length === 0) {
        throw new Error("No response received from AI")
      }

      // Apply character limit
      const limitedContent = TextLimiter.truncateAtWordBoundary(responseContent, validMaxLength)

      // Format response with proper structure
      const chatResponse = {
        message: limitedContent,
        relatedTopics: this.extractTopicsFromResponse(limitedContent),
        suggestedFollowUp: this.generateConversationalFollowUp(query as string),
        educationalLevel: "intermediate",
        processingTime: 0 // Will be set by calling agent
      }

      print(`GeneralConversationTool: Generated conversational response`)
      print(`GeneralConversationTool: 📝 Response length: ${chatResponse.message.length} chars`)

      return { success: true, result: chatResponse }
    } catch (error) {
      print(`GeneralConversationTool: ERROR - Conversational AI call failed: ${error}`)

      // Return a simple fallback (last resort)
      return {
        success: true,
        result: {
          message: "I'm here to help! What would you like to know or discuss?",
          relatedTopics: ["conversation", "help"],
          suggestedFollowUp: ["What topic interests you?", "How can I assist you today?"],
          educationalLevel: "intermediate",
          processingTime: 0
        }
      }
    }
  }

  private extractTopicsFromResponse(content: string): string[] {
    // Extract general topics for conversation
    const conversationKeywords = content
      .toLowerCase()
      .match(/\b(help|learn|understand|question|topic|discuss|explain|explore|study|know)\b/g)

    if (!conversationKeywords) {
      return ["conversation", "assistance"]
    }

    const uniqueKeywords = [...new Set(conversationKeywords)]
    return uniqueKeywords.slice(0, 3)
  }

  private generateConversationalFollowUp(query: string): string[] {
    const lowerQuery = query.toLowerCase()

    if (lowerQuery.includes("hello") || lowerQuery.includes("hi") || lowerQuery.includes("hey")) {
      return [
        "What topic would you like to explore?",
        "Is there something specific you'd like to learn about?",
        "How can I help you today?"
      ]
    }

    if (lowerQuery.includes("what") || lowerQuery.includes("how") || lowerQuery.includes("why")) {
      return [
        "Would you like me to explain that in more detail?",
        "Are there specific aspects you'd like to know more about?",
        "Do you have related questions?"
      ]
    }

    return [
      "What else would you like to know?",
      "Is there anything specific you'd like me to clarify?",
      "Would you like to explore this topic further?"
    ]
  }
}
