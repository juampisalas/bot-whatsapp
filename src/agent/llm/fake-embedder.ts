import { EMBEDDING_DIMENSIONS, type Embedder } from './embedder.ts'

/**
 * Deterministic embedder for tests. Vectors are derived from a hash of each
 * text so identical inputs always score as most similar to themselves.
 */
export class FakeEmbedder implements Embedder {
  readonly model: string
  readonly dimensions = EMBEDDING_DIMENSIONS
  readonly calls: string[][] = []

  private forcedDimensions: number | null = null

  constructor(model = 'fake-embed') {
    this.model = model
  }

  /** Next `embed` call returns vectors of this length (then resets). */
  forceNextDimensions(dimensions: number): void {
    this.forcedDimensions = dimensions
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts])
    const dims = this.forcedDimensions ?? this.dimensions
    this.forcedDimensions = null
    return texts.map((text) => hashToVector(text, dims))
  }
}

function hashToVector(text: string, dimensions: number): number[] {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }

  const out = new Array<number>(dimensions)
  for (let i = 0; i < dimensions; i++) {
    h ^= i + 1
    h = Math.imul(h, 16777619)
    out[i] = ((h >>> 0) / 0xffffffff) * 2 - 1
  }
  return out
}
