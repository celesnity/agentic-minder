import { RemoteVectorMemoryClient } from "../Storage/RemoteVectorMemoryClient"

/**
 * VectorDB List Tool - Lists all chunks in the VectorDB with pagination
 * Allows users to view what data has been collected and stored
 */
export class VectorListTool {
  public readonly name = "vector_list_tool"
  public readonly description = "Lists all chunks stored in the VectorDB with pagination support"

  public readonly parameters = {
    type: "object",
    properties: {
      limit: { 
        type: "number", 
        description: "Maximum number of chunks to retrieve",
        default: 50 
      },
      offset: { 
        type: "number", 
        description: "Number of chunks to skip (for pagination)",
        default: 0 
      },
      showPreview: {
        type: "boolean",
        description: "Whether to include text previews",
        default: true
      }
    },
    required: []
  }

  private remoteClient: RemoteVectorMemoryClient | null = null

  constructor() {
    print("VectorListTool: 📋 Vector list tool initialized")
  }

  /**
   * Set the remote vector memory client
   */
  public setRemoteClient(client: RemoteVectorMemoryClient): void {
    this.remoteClient = client
    print("VectorListTool: ✅ Connected to RemoteVectorMemoryClient")
  }

  public async execute(args: Record<string, unknown>): Promise<{ success: boolean; result?: any; error?: string }> {
    const {
      limit = 50,
      offset = 0,
      showPreview = true
    } = args

    if (!this.remoteClient) {
      return { 
        success: false, 
        error: "VectorDB client not configured. Please enable remote vector service." 
      }
    }

    try {
      print(`VectorListTool: 📋 Listing chunks (limit: ${limit}, offset: ${offset})`)

      const response = await this.remoteClient.listChunks(limit as number, offset as number)
      
      const chunks = response.chunks || []
      const totalCount = response.total_count || 0
      const hasMore = response.has_more || false

      print(`VectorListTool: ✅ Retrieved ${chunks.length} chunks (total: ${totalCount})`)

      // Format chunks for display
      const formattedChunks = chunks.map((chunk, index) => {
        const preview = showPreview ? chunk.text_preview : `${chunk.text.length} chars`
        return {
          index: (offset as number) + index + 1,
          chunk_id: chunk.chunk_id,
          point_id: chunk.point_id,
          created_at: new Date(chunk.created_at).toLocaleString(),
          text_length: chunk.text.length,
          preview: preview
        }
      })

      return {
        success: true,
        result: {
          chunks: formattedChunks,
          total_count: totalCount,
          showing_count: chunks.length,
          has_more: hasMore,
          current_page: Math.floor((offset as number) / (limit as number)) + 1,
          message: `Showing ${chunks.length} of ${totalCount} total chunks${hasMore ? ' (more available)' : ''}`
        }
      }
    } catch (error) {
      print(`VectorListTool: ❌ ERROR - Failed to list chunks: ${error}`)
      return {
        success: false,
        error: `Failed to list chunks: ${error}`
      }
    }
  }
}
