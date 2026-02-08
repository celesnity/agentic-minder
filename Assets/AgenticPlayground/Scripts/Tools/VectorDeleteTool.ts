import { RemoteVectorMemoryClient } from "../Storage/RemoteVectorMemoryClient"

/**
 * VectorDB Delete Tool - Deletes specific chunks from the VectorDB
 * Allows users to remove unwanted or old recordings
 */
export class VectorDeleteTool {
  public readonly name = "vector_delete_tool"
  public readonly description = "Deletes specific chunks from the VectorDB by their IDs"

  public readonly parameters = {
    type: "object",
    properties: {
      chunk_ids: { 
        type: "array", 
        description: "Array of chunk IDs to delete",
        items: { type: "string" }
      },
      confirm: {
        type: "boolean",
        description: "Confirmation flag to prevent accidental deletion",
        default: false
      }
    },
    required: ["chunk_ids", "confirm"]
  }

  private remoteClient: RemoteVectorMemoryClient | null = null

  constructor() {
    print("VectorDeleteTool: 🗑️ Vector delete tool initialized")
  }

  /**
   * Set the remote vector memory client
   */
  public setRemoteClient(client: RemoteVectorMemoryClient): void {
    this.remoteClient = client
    print("VectorDeleteTool: ✅ Connected to RemoteVectorMemoryClient")
  }

  public async execute(args: Record<string, unknown>): Promise<{ success: boolean; result?: any; error?: string }> {
    const {
      chunk_ids,
      confirm = false
    } = args

    if (!this.remoteClient) {
      return { 
        success: false, 
        error: "VectorDB client not configured. Please enable remote vector service." 
      }
    }

    if (!chunk_ids || !Array.isArray(chunk_ids) || chunk_ids.length === 0) {
      return {
        success: false,
        error: "chunk_ids parameter is required and must be a non-empty array"
      }
    }

    if (!confirm) {
      return {
        success: false,
        error: "Deletion requires confirmation. Set confirm: true to proceed with deletion."
      }
    }

    try {
      print(`VectorDeleteTool: 🗑️ Deleting ${chunk_ids.length} chunks`)
      print(`VectorDeleteTool: 📋 Chunk IDs: ${chunk_ids.join(", ")}`)

      const deletedCount = await this.remoteClient.deleteChunks(chunk_ids as string[])

      print(`VectorDeleteTool: ✅ Successfully deleted ${deletedCount} chunks`)

      return {
        success: true,
        result: {
          deleted_count: deletedCount,
          chunk_ids: chunk_ids,
          message: `Successfully deleted ${deletedCount} chunk(s) from VectorDB`
        }
      }
    } catch (error) {
      print(`VectorDeleteTool: ❌ ERROR - Failed to delete chunks: ${error}`)
      return {
        success: false,
        error: `Failed to delete chunks: ${error}`
      }
    }
  }
}
