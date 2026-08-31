import { embedMany, type EmbeddingModel } from 'ai'

export const EMBEDDING_DIMENSIONS = 768 as const

export interface Embedder {
  readonly model: string
  readonly dimensions: typeof EMBEDDING_DIMENSIONS
  embed(texts: string[]): Promise<number[][]>
}

/**
 * Thin AI SDK adapter. Task 7 wires this into the registry with a real model.
 */
export function createSdkEmbedder(modelId: string, model: EmbeddingModel): Embedder {
  return {
    model: modelId,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return []
      const { embeddings } = await embedMany({ model, values: texts })
      return embeddings
    },
  }
}
