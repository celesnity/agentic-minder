import {OpenAI} from "RemoteServiceGateway.lspkg/HostedExternal/OpenAI"
import {OpenAITypes} from "RemoteServiceGateway.lspkg/HostedExternal/OpenAITypes"

/**
 * OpenAIEmbedder - Demo-grade embedding service built on supported RSG OpenAI APIs.
 *
 * NOTE:
 * Remote Service Gateway may not expose a native embeddings endpoint in this project.
 * For this demo, we prompt an LLM to output a fixed-length numeric embedding vector.
 */
export class OpenAIEmbedder {
  private model: string
  private dimensions: number
  private enableDebugLogging: boolean

  constructor(options?: {model?: string; dimensions?: number; enableDebugLogging?: boolean}) {
    this.model = options?.model || "gpt-4o-mini"
    this.dimensions = options?.dimensions || 64
    this.enableDebugLogging = options?.enableDebugLogging ?? false
  }

  public async embed(text: string): Promise<number[]> {
    const input = this.normalizeInput(text)

    if (!input) {
      throw new Error("OpenAIEmbedder: Empty text provided")
    }

    const systemPrompt =
      `You are an embedding generator. Return ONLY valid JSON.\n` +
      `Output schema: {"embedding":[number,...]}\n` +
      `Rules:\n` +
      `- embedding must be an array of exactly ${this.dimensions} floats\n` +
      `- values should be roughly normalized (e.g., between -1 and 1)\n` +
      `- do not include any other keys or text`

    const userPrompt = `Text:\n${input}`

    const request: OpenAITypes.ChatCompletions.Request = {
      model: this.model.toLowerCase(),
      messages: [
        {role: "system", content: systemPrompt},
        {role: "user", content: userPrompt}
      ],
      temperature: 0,
      max_tokens: 600,
      response_format: {type: "json_object"}
    }

    if (this.enableDebugLogging) {
      print(`OpenAIEmbedder: Requesting ${this.dimensions}D embedding via ${this.model}`)
    }

    const response = await OpenAI.chatCompletions(request)
    const content = response?.choices?.[0]?.message?.content

    if (!content || typeof content !== "string") {
      throw new Error("OpenAIEmbedder: No content returned from OpenAI")
    }

    const embedding = this.parseEmbedding(content)
    if (embedding.length !== this.dimensions) {
      throw new Error(`OpenAIEmbedder: Expected ${this.dimensions} dims, got ${embedding.length}`)
    }

    return embedding
  }

  private normalizeInput(text: string): string {
    if (!text) return ""
    const trimmed = text.trim()
    if (!trimmed) return ""

    // Keep it small and stable for a cheap demo embedding call
    // (semantic retrieval is chunk-level anyway).
    const maxChars = 1200
    return trimmed.length > maxChars ? trimmed.substring(0, maxChars) : trimmed
  }

  private parseEmbedding(jsonText: string): number[] {
    try {
      const parsed = JSON.parse(jsonText) as any
      const arr = parsed?.embedding
      if (!Array.isArray(arr)) {
        throw new Error("Missing embedding array")
      }

      const numbers = arr
        .map((v) => (typeof v === "number" ? v : Number(v)))
        .filter((v) => Number.isFinite(v))

      return numbers
    } catch (error) {
      // Best-effort fallback: extract first JSON object / array if model returns extra text.
      const objMatch = jsonText.match(/\{[\s\S]*\}/)
      if (objMatch) {
        try {
          const parsed = JSON.parse(objMatch[0]) as any
          const arr = parsed?.embedding
          if (Array.isArray(arr)) {
            return arr.map((v) => (typeof v === "number" ? v : Number(v))).filter((v) => Number.isFinite(v))
          }
        } catch (_) {
          // ignore
        }
      }

      throw new Error(`OpenAIEmbedder: Failed to parse embedding JSON: ${error}`)
    }
  }
}

