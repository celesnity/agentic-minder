import {AgentLanguageInterface} from "../Agents/AgentLanguageInterface"
import {ChatStorage} from "../Storage/ChatStorage"
import {DiagramStorage} from "../Storage/DiagramStorage"
import {SummaryStorage} from "../Storage/SummaryStorage"
import {RemoteVectorMemoryClient} from "../Storage/RemoteVectorMemoryClient"
import {DiagramCreatorTool} from "./DiagramCreatorTool"
import {GeneralConversationTool} from "./GeneralConversationTool"
import {SpatialTool} from "./SpatialTool"
import {SummaryTool} from "./SummaryTool"
import {VectorSearchTool} from "./VectorSearchTool"
import {VectorListTool} from "./VectorListTool"
import {VectorCountTool} from "./VectorCountTool"
import {VectorDeleteTool} from "./VectorDeleteTool"

/**
 * Tool metadata for AI routing decisions
 */
interface ToolMetadata {
  name: string
  description: string
  capabilities: string[]
  useWhen: string[]
  instance: any
}

/**
 * Intelligent AI-powered tool router that uses LLM reasoning for routing decisions
 * Replaces primitive string matching with contextual understanding
 */
export class ToolRouter {
  private languageInterface: AgentLanguageInterface
  private toolIndex: Map<string, ToolMetadata> = new Map()
  private enableDebugLogging: boolean = true
  private diagramCreatorTool: DiagramCreatorTool
  private generalConversationTool: GeneralConversationTool
  private vectorSearchTool: VectorSearchTool
  private vectorListTool: VectorListTool
  private vectorCountTool: VectorCountTool
  private vectorDeleteTool: VectorDeleteTool

  constructor(languageInterface: AgentLanguageInterface, diagramStorage?: DiagramStorage) {
    this.languageInterface = languageInterface

    // Initialize tools
    this.diagramCreatorTool = new DiagramCreatorTool(languageInterface, diagramStorage)
    this.generalConversationTool = new GeneralConversationTool(languageInterface)
    const summaryTool = new SummaryTool(languageInterface)
    const spatialTool = new SpatialTool(languageInterface)
    
    // Initialize VectorDB CRUD tools
    this.vectorSearchTool = new VectorSearchTool(languageInterface)
    this.vectorListTool = new VectorListTool()
    this.vectorCountTool = new VectorCountTool()
    this.vectorDeleteTool = new VectorDeleteTool()

    // Index tools with their capabilities and use cases
    this.indexTool("diagram_tool", {
      name: "diagram_tool",
      description: "Creates visual diagrams from conversation content and learning points",
      capabilities: [
        "Create mind maps and concept diagrams",
        "Visualize educational content structure",
        "Generate interactive learning diagrams",
        "Organize information into visual hierarchies"
      ],
      useWhen: [
        "User explicitly requests a diagram, chart, or visualization",
        'User wants to "create", "draw", "visualize", or "map" concepts',
        'User asks to "show relationships" or "organize information visually"',
        "User requests mind maps, flowcharts, or concept maps"
      ],
      instance: this.diagramCreatorTool
    })

    this.indexTool("summary_tool", {
      name: "summary_tool",
      description:
        "Focuses on previous lecture summary content and answers specific questions about summarized material",
      capabilities: [
        "Answer questions about previously summarized lecture content",
        "Reference specific points from the lecture summary",
        "Explain concepts covered in the summarized material",
        "Provide details from the documented lecture content"
      ],
      useWhen: [
        'User asks about "the lecture" content (refers to summarized material)',
        "User wants information from previous summary or lecture notes",
        "User asks about specific topics covered in the documented content",
        'User references "what we learned", "what was discussed", or "lecture material"',
        "User asks for lecture title, topics, or key points from summarized content"
      ],
      instance: summaryTool
    })

    this.indexTool("spatial_tool", {
      name: "spatial_tool",
      description: "Answers questions about live lecture environment using camera input and spatial awareness",
      capabilities: [
        "Analyze current physical environment with camera",
        "Provide real-time spatial context",
        "Answer questions about what is currently happening",
        "Observe live presentations or current surroundings"
      ],
      useWhen: [
        'User asks about current/live environment or "what do you see right now"',
        "User wants real-time analysis of physical space",
        'User asks about "current presentation" happening live (not summarized)',
        "User requests camera-based observation of immediate surroundings"
      ],
      instance: spatialTool
    })

    this.indexTool("general_conversation", {
      name: "general_conversation",
      description: "Handles general conversation and educational questions with access to lecture summaries",
      capabilities: [
        "Provide general educational assistance",
        "Answer broad knowledge questions",
        "Engage in conversational learning",
        "Handle queries not requiring specialized tools",
        "Access lecture summaries for context"
      ],
      useWhen: [
        "General educational questions not related to specific lecture content",
        "Broad knowledge questions or concept explanations",
        "Conversational learning that doesn't need specialized context",
        "Default choice when no other tool is specifically needed"
      ],
      instance: this.generalConversationTool
    })

    // Register VectorDB CRUD tools
    this.indexTool("vector_search_tool", {
      name: "vector_search_tool",
      description: "Performs semantic search on VectorDB to find relevant recorded chunks by meaning",
      capabilities: [
        "Semantic search in recorded transcripts",
        "Find chunks by meaning (not exact text)",
        "Search past recordings and lectures",
        "Query stored knowledge base"
      ],
      useWhen: [
        'User wants to find specific content in recordings (e.g., "search for X")',
        'User asks to search for topics in stored data (e.g., "find discussions about Y")',
        'User explicitly requests to "search" or "find" something in recordings',
        "User wants to retrieve information from recorded content by topic"
      ],
      instance: this.vectorSearchTool
    })

    this.indexTool("vector_list_tool", {
      name: "vector_list_tool",
      description: "Lists all chunks stored in VectorDB with pagination support",
      capabilities: [
        "View all recorded chunks",
        "Browse stored recordings with previews",
        "List data with pagination",
        "Show overview of stored content"
      ],
      useWhen: [
        'User wants to see all recordings (e.g., "show me all my data")',
        'User asks "what data do I have stored" or "list my recordings"',
        "User requests data overview or inventory",
        'User wants to browse recorded content (e.g., "show all chunks")'
      ],
      instance: this.vectorListTool
    })

    this.indexTool("vector_count_tool", {
      name: "vector_count_tool",
      description: "Gets statistics about stored chunks in VectorDB",
      capabilities: [
        "Count total chunks stored",
        "Provide storage statistics",
        "Show database metrics",
        "Analyze data quality"
      ],
      useWhen: [
        'User asks "how many recordings do I have"',
        "User requests storage statistics or metrics",
        'User checks database state (e.g., "storage count")',
        'User wants quick overview (e.g., "what\'s my storage size")'
      ],
      instance: this.vectorCountTool
    })

    this.indexTool("vector_delete_tool", {
      name: "vector_delete_tool",
      description: "Deletes specific chunks from VectorDB (requires confirmation)",
      capabilities: [
        "Delete specific chunks by ID",
        "Remove unwanted recordings",
        "Clean up old data",
        "Clear selected chunks"
      ],
      useWhen: [
        'User wants to delete specific chunks by ID (e.g., "delete chunk_123")',
        'User requests data cleanup (e.g., "remove old recordings")',
        "User wants to clear unwanted data",
        'User says "delete" or "remove" recordings'
      ],
      instance: this.vectorDeleteTool
    })

    if (this.enableDebugLogging) {
      print(`ToolRouter: 🧠 AI-powered intelligent tool router initialized with ${this.toolIndex.size} indexed tools`)
      print("ToolRouter: 📚 Tools indexed: " + Array.from(this.toolIndex.keys()).join(", "))
    }
  }

  /**
   * Set the summary storage for tools that need it
   */
  public setSummaryStorage(summaryStorage: SummaryStorage): void {
    if (this.diagramCreatorTool) {
      this.diagramCreatorTool.setSummaryStorage(summaryStorage)
      print("ToolRouter: Connected SummaryStorage to DiagramCreatorTool")
    }
    if (this.generalConversationTool) {
      this.generalConversationTool.setSummaryStorage(summaryStorage)
      print("ToolRouter: Connected SummaryStorage to GeneralConversationTool")
    }
  }

  /**
   * Set the chat storage for tools that need it
   */
  public setChatStorage(chatStorage: ChatStorage): void {
    if (this.diagramCreatorTool) {
      this.diagramCreatorTool.setChatStorage(chatStorage)
      print("ToolRouter: Connected ChatStorage to DiagramCreatorTool")
    }
  }

  /**
   * Set the RemoteVectorMemoryClient for tools that need VectorDB access
   */
  public setVectorClient(client: RemoteVectorMemoryClient): void {
    // Connect to GeneralConversationTool for auto-search
    if (this.generalConversationTool) {
      this.generalConversationTool.setVectorClient(client)
      print("ToolRouter: ✅ Connected VectorDB client to GeneralConversationTool (auto-search)")
    }
    
    // Connect to VectorDB CRUD tools
    this.vectorSearchTool.setRemoteClient(client)
    this.vectorListTool.setRemoteClient(client)
    this.vectorCountTool.setRemoteClient(client)
    this.vectorDeleteTool.setRemoteClient(client)
    print("ToolRouter: ✅ Connected VectorDB client to all 4 CRUD tools")
  }

  /**
   * Index a tool with its metadata for AI routing decisions
   */
  private indexTool(key: string, metadata: ToolMetadata): void {
    this.toolIndex.set(key, metadata)
    if (this.enableDebugLogging) {
      print(`ToolRouter: 📖 Indexed tool "${key}" with ${metadata.capabilities.length} capabilities`)
    }
  }

  /**
   * AI-powered intelligent routing - uses LLM to make routing decisions
   */
  public async routeQuery(args: Record<string, unknown>): Promise<{success: boolean; result?: any; error?: string}> {
    const {query, summaryContext, retrievalContext} = args

    if (!query || typeof query !== "string") {
      return {success: false, error: "Query parameter is required and must be a string"}
    }

    try {
      // Get routing decision from AI
      const selectedTool = await this.getAIRoutingDecision(query as string, summaryContext, retrievalContext as any)

      if (!selectedTool || !this.toolIndex.has(selectedTool)) {
        print(`ToolRouter: AI selected unknown tool "${selectedTool}", falling back to general_conversation`)
        const fallbackTool = this.toolIndex.get("general_conversation")!
        return await fallbackTool.instance.execute(args)
      }

      const toolMetadata = this.toolIndex.get(selectedTool)!

      if (this.enableDebugLogging) {
        print(
          `ToolRouter: 🧠 AI routing decision: "${selectedTool}" for query: "${(query as string).substring(0, 50)}..."`
        )
        print(`ToolRouter: 💡 Reasoning: ${toolMetadata.description}`)
      }

      return await toolMetadata.instance.execute(args)
    } catch (error) {
      print(`ToolRouter: AI routing failed: ${error}`)
      // Fallback to general conversation on error
      const fallbackTool = this.toolIndex.get("general_conversation")!
      return await fallbackTool.instance.execute(args)
    }
  }

  /**
   * Use AI to make intelligent routing decision based on context and intent
   */
  private async getAIRoutingDecision(query: string, summaryContext?: any, retrievalContext?: any): Promise<string> {
    // Build tool index description for AI
    const toolDescriptions = Array.from(this.toolIndex.values())
      .map((tool) => {
        return `**${tool.name}**:
- Description: ${tool.description}
- Use when: ${tool.useWhen.join("; ")}
- Capabilities: ${tool.capabilities.join("; ")}`
      })
      .join("\n\n")

    // Build context information
    let contextInfo = ""
    if (summaryContext && summaryContext.title) {
      contextInfo = `\n\nAVAILABLE CONTEXT:
- Lecture Summary Available: "${summaryContext.title}"
- Summary Content: ${summaryContext.content ? "Yes" : "No"}
- Key Points Available: ${summaryContext.keyPoints ? summaryContext.keyPoints.length + " points" : "No"}`
    }
    if (retrievalContext && typeof retrievalContext === "string" && retrievalContext.trim().length > 0) {
      contextInfo += `\n\nLATEST TRANSCRIPT EXCERPTS AVAILABLE: Yes`
    }

    const routingPrompt = `You are an intelligent tool router for an educational AI assistant. Analyze the user query and select the most appropriate tool.

AVAILABLE TOOLS:
${toolDescriptions}${contextInfo}

USER QUERY: "${query}"

ROUTING RULES:
1. If user asks about "the lecture" or lecture content, and summary context is available, use "summary_tool"
2. If user requests diagrams, visualizations, or mind maps, use "diagram_tool"  
3. If user asks about current/live environment or "what do you see", use "spatial_tool"
4. If user explicitly wants to SEARCH recorded data (e.g., "search for...", "find recordings about..."), use "vector_search_tool"
5. If user wants to LIST/VIEW all recordings (e.g., "show all my data", "list recordings"), use "vector_list_tool"
6. If user asks HOW MANY/COUNT (e.g., "how many recordings", "storage count"), use "vector_count_tool"
7. If user wants to DELETE data (e.g., "delete chunk_XXX", "remove recordings"), use "vector_delete_tool"
8. For general questions or when user asks about recordings but doesn't explicitly request search/list/count/delete, use "general_conversation" (it will auto-search VectorDB for context)

Respond with ONLY the tool name (e.g., "summary_tool", "vector_search_tool", "general_conversation").`

    try {
      // Get routing decision from current language interface
      // Uses generateTextResponse() for silent routing (no voice output needed for internal decisions)
      const response = await this.languageInterface.generateTextResponse([
        {
          role: "user",
          content: routingPrompt
        }
      ])

      if (!response || typeof response !== "string") {
        throw new Error("Invalid routing response from AI")
      }

      // Extract tool name from response
      const toolName = response.trim().toLowerCase()

      // Validate tool name
      const validTools = Array.from(this.toolIndex.keys())
      const selectedTool = validTools.find((tool) => toolName.includes(tool))

      if (!selectedTool) {
        print(`ToolRouter: AI response "${toolName}" didn't match any indexed tool, using general_conversation`)
        return "general_conversation"
      }

      return selectedTool
    } catch (error) {
      print(`ToolRouter: AI routing decision failed: ${error}`)
      return "general_conversation"
    }
  }

  /**
   * Get tool information for registration with AgentToolExecutor
   */
  public getToolInfo() {
    return {
      name: "intelligent_conversation",
      description:
        "AI-powered intelligent router that analyzes queries and selects the most appropriate specialized tool for educational responses, diagram creation, summary analysis, or spatial awareness",
      parameters: {
        type: "object",
        properties: {
          query: {type: "string", description: "User query to analyze and route to appropriate tool"},
          context: {type: "array", description: "Array of previous conversation messages for routing context"},
          summaryContext: {type: "object", description: "Summary of lecture content - critical for routing decisions"},
          maxLength: {type: "number", description: "Maximum character length for the response"},
          educationalFocus: {type: "boolean", description: "Whether to focus on educational content"}
        },
        required: ["query"]
      }
    }
  }

  /**
   * Get indexed tools information for debugging
   */
  public getIndexedTools(): string[] {
    return Array.from(this.toolIndex.keys())
  }

  /**
   * Get tool metadata for debugging
   */
  public getToolMetadata(toolName: string): ToolMetadata | undefined {
    return this.toolIndex.get(toolName)
  }
}
