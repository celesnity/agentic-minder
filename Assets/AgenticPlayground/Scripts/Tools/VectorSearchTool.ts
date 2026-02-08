import { RemoteVectorMemoryClient } from "../Storage/RemoteVectorMemoryClient"
import { AgentLanguageInterface } from "../Agents/AgentLanguageInterface"

/**
 * VectorDB Search Tool - Performs semantic search on VectorDB
 * Allows users to find relevant chunks by meaning, not exact text
 */
export class VectorSearchTool {
  public readonly name = "vector_search_tool"
  public readonly description = "Performs semantic search on VectorDB to find relevant chunks by meaning"

  public readonly parameters = {
    type: "object",
    properties: {
      query: { 
        type: "string", 
        description: "The search query (natural language)"
      },
      top_k: {
        type: "number",
        description: "Number of most relevant chunks to return",
        default: 5
      },
      min_score: {
        type: "number",
        description: "Minimum relevance score (0.0 - 1.0)",
        default: 0.3
      },
      summarize_results: {
        type: "boolean",
        description: "Whether to generate an AI summary of search results",
        default: true
      }
    },
    required: ["query"]
  }

  private remoteClient: RemoteVectorMemoryClient | null = null
  private languageInterface: AgentLanguageInterface

  constructor(languageInterface: AgentLanguageInterface) {
    this.languageInterface = languageInterface
    print("VectorSearchTool: 🔍 Vector search tool initialized")
  }

  /**
   * Set the remote vector memory client
   */
  public setRemoteClient(client: RemoteVectorMemoryClient): void {
    this.remoteClient = client
    print("VectorSearchTool: ✅ Connected to RemoteVectorMemoryClient")
  }

  public async execute(args: Record<string, unknown>): Promise<{ success: boolean; result?: any; error?: string }> {
    const {
      query,
      top_k = 5,
      min_score = 0.3,
      summarize_results = true
    } = args

    if (!query || typeof query !== "string") {
      return {
        success: false,
        error: "query parameter is required and must be a string"
      }
    }

    if (!this.remoteClient) {
      return { 
        success: false, 
        error: "VectorDB client not configured. Please enable remote vector service." 
      }
    }

    try {
      print(`VectorSearchTool: 🔍 Searching for: "${(query as string).substring(0, 50)}..."`)
      print(`VectorSearchTool: 📊 Parameters - top_k: ${top_k}, min_score: ${min_score}`)

      const matches = await this.remoteClient.search(query as string, top_k as number)
      
      // Filter by minimum score
      const relevantMatches = matches.filter(m => m.score >= (min_score as number))

      print(`VectorSearchTool: ✅ Found ${relevantMatches.length} relevant matches (filtered from ${matches.length})`)

      if (relevantMatches.length === 0) {
        return {
          success: true,
          result: {
            matches: [],
            match_count: 0,
            message: `No relevant chunks found for query: "${query}"`
          }
        }
      }

      // Format matches
      const formattedMatches = relevantMatches.map((match, index) => ({
        rank: index + 1,
        score: Math.round(match.score * 100) / 100,
        text_preview: match.text.substring(0, 150) + "...",
        full_text: match.text,
        created_at: match.created_at ? new Date(match.created_at).toLocaleString() : "unknown"
      }))

      // Generate AI summary of results if requested
      let aiSummary = ""
      if (summarize_results && relevantMatches.length > 0) {
        aiSummary = await this.generateSearchSummary(query as string, relevantMatches)
      }

      return {
        success: true,
        result: {
          query: query,
          matches: formattedMatches,
          match_count: relevantMatches.length,
          ai_summary: aiSummary,
          message: `Found ${relevantMatches.length} relevant chunk(s) for: "${query}"`
        }
      }
    } catch (error) {
      print(`VectorSearchTool: ❌ ERROR - Search failed: ${error}`)
      return {
        success: false,
        error: `Search failed: ${error}`
      }
    }
  }

  /**
   * Generate AI summary of search results
   */
  private async generateSearchSummary(query: string, matches: Array<{score: number; text: string}>): Promise<string> {
    try {
      const topMatches = matches.slice(0, 3)
      const context = topMatches.map((m, i) => `[Match ${i+1}, Score: ${m.score.toFixed(2)}]\n${m.text}`).join("\n\n")

      const systemPrompt = `You are summarizing search results from a VectorDB.
The user searched for: "${query}"

Here are the most relevant chunks found:

${context}

Generate a concise summary (max 200 chars) that:
- Answers the user's query based on these chunks
- Mentions key information found
- Is conversational and helpful

Keep it brief and focused!`

      const response = await this.languageInterface.generateResponse(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Summarize what was found about: ${query}` }
        ],
        {
          temperature: 0.7,
          maxTokens: 100,
          textOnly: true
        }
      )

      const summary = response?.content || "Search completed successfully."
      print(`VectorSearchTool: 📝 Generated AI summary (${summary.length} chars)`)
      
      return summary.substring(0, 200)
    } catch (error) {
      print(`VectorSearchTool: ⚠️ Failed to generate AI summary: ${error}`)
      return `Found ${matches.length} relevant chunks for your query.`
    }
  }
}
