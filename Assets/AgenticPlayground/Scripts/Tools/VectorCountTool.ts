import { RemoteVectorMemoryClient } from "../Storage/RemoteVectorMemoryClient"

/**
 * VectorDB Count Tool - Gets statistics about stored chunks
 * Provides quick overview of VectorDB state
 */
export class VectorCountTool {
  public readonly name = "vector_count_tool"
  public readonly description = "Gets the total count of chunks stored in the VectorDB"

  public readonly parameters = {
    type: "object",
    properties: {
      detailed: {
        type: "boolean",
        description: "Whether to include detailed statistics",
        default: false
      }
    },
    required: []
  }

  private remoteClient: RemoteVectorMemoryClient | null = null

  constructor() {
    print("VectorCountTool: 🔢 Vector count tool initialized")
  }

  /**
   * Set the remote vector memory client
   */
  public setRemoteClient(client: RemoteVectorMemoryClient): void {
    this.remoteClient = client
    print("VectorCountTool: ✅ Connected to RemoteVectorMemoryClient")
  }

  public async execute(args: Record<string, unknown>): Promise<{ success: boolean; result?: any; error?: string }> {
    const { detailed = false } = args

    if (!this.remoteClient) {
      return { 
        success: false, 
        error: "VectorDB client not configured. Please enable remote vector service." 
      }
    }

    try {
      print("VectorCountTool: 🔢 Getting chunk count...")

      const count = await this.remoteClient.getChunkCount()

      print(`VectorCountTool: ✅ VectorDB contains ${count} chunks`)

      const result: any = {
        count: count,
        message: `VectorDB contains ${count} chunk(s)`
      }

      // If detailed stats requested, fetch sample data
      if (detailed && count > 0) {
        try {
          const sampleData = await this.remoteClient.listChunks(10, 0)
          const chunks = sampleData.chunks || []
          
          if (chunks.length > 0) {
            const totalChars = chunks.reduce((sum, c) => sum + c.text.length, 0)
            const avgChars = Math.round(totalChars / chunks.length)
            
            const times = chunks.map(c => c.created_at)
            const firstTime = Math.min(...times)
            const lastTime = Math.max(...times)
            const durationMinutes = Math.round((lastTime - firstTime) / 60000)

            result.statistics = {
              average_chunk_size: avgChars,
              total_characters_sampled: totalChars,
              sample_size: chunks.length,
              time_span_minutes: durationMinutes,
              oldest_chunk: new Date(firstTime).toLocaleString(),
              newest_chunk: new Date(lastTime).toLocaleString()
            }
            
            print(`VectorCountTool: 📊 Statistics - avg size: ${avgChars} chars, span: ${durationMinutes} min`)
          }
        } catch (statsError) {
          print(`VectorCountTool: ⚠️ Failed to fetch detailed stats: ${statsError}`)
        }
      }

      return { success: true, result }
    } catch (error) {
      print(`VectorCountTool: ❌ ERROR - Failed to get count: ${error}`)
      return {
        success: false,
        error: `Failed to get chunk count: ${error}`
      }
    }
  }
}
