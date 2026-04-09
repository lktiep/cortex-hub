/**
 * Local embedding via @xenova/transformers (ONNX runtime, no Python).
 *
 * Uses lightweight sentence-transformers models like all-MiniLM-L6-v2:
 * - 80MB model, ~200MB RAM
 * - 384-dim embeddings
 * - 10-50ms/text on CPU
 * - 100% offline after initial model download
 *
 * The pipeline is loaded lazily on first call and cached as a singleton.
 * Subsequent calls reuse the same in-memory model.
 */

// Use dynamic import to keep this optional — only loaded when provider='local'
type FeatureExtractionPipeline = (text: string | string[], options?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean }) => Promise<{
  data: Float32Array
  dims: number[]
}>

let pipelineSingleton: FeatureExtractionPipeline | null = null
let currentModelId: string | null = null
let loadPromise: Promise<FeatureExtractionPipeline> | null = null

/**
 * Get or initialize the singleton pipeline for the given model.
 * Concurrent calls during initialization share the same load promise.
 */
async function getPipeline(modelId: string): Promise<FeatureExtractionPipeline> {
  if (pipelineSingleton && currentModelId === modelId) {
    return pipelineSingleton
  }
  if (loadPromise && currentModelId === modelId) {
    return loadPromise
  }

  currentModelId = modelId
  loadPromise = (async () => {
    // Dynamic import — keeps @xenova/transformers as an optional runtime dep
    const transformers = await import('@xenova/transformers') as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<FeatureExtractionPipeline>
      env?: { allowLocalModels?: boolean; useBrowserCache?: boolean }
    }

    // Configure to use HuggingFace remote models (cached locally on disk after first download)
    if (transformers.env) {
      transformers.env.allowLocalModels = false
      transformers.env.useBrowserCache = false
    }

    const pipe = await transformers.pipeline('feature-extraction', modelId, {
      quantized: true, // smaller download, slightly lower precision
    })
    pipelineSingleton = pipe
    loadPromise = null
    return pipe
  })()

  return loadPromise
}

/**
 * Embed a single text using the local model.
 * Returns a normalized vector suitable for cosine similarity.
 */
export async function embedLocal(text: string, modelId: string): Promise<number[]> {
  const pipe = await getPipeline(modelId)
  const output = await pipe(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

/**
 * Batch-embed multiple texts. The pipeline supports batching natively for speed.
 */
export async function embedLocalBatch(texts: string[], modelId: string): Promise<number[][]> {
  if (texts.length === 0) return []
  const pipe = await getPipeline(modelId)
  const output = await pipe(texts, { pooling: 'mean', normalize: true })
  // Output is a single tensor [batch, dim] — split by batch
  const dim = output.dims[output.dims.length - 1] ?? 384
  const result: number[][] = []
  for (let i = 0; i < texts.length; i++) {
    const start = i * dim
    result.push(Array.from(output.data.slice(start, start + dim)))
  }
  return result
}

/**
 * Returns the dimension of the loaded model, or null if not yet loaded.
 * Useful for ensuring Qdrant collection has the right vector size.
 */
export function getLocalEmbeddingDim(modelId: string): number {
  // Known dimensions for common models
  const knownDims: Record<string, number> = {
    'Xenova/all-MiniLM-L6-v2': 384,
    'Xenova/all-MiniLM-L12-v2': 384,
    'Xenova/bge-small-en-v1.5': 384,
    'Xenova/bge-base-en-v1.5': 768,
    'Xenova/multilingual-e5-small': 384,
  }
  return knownDims[modelId] ?? 384
}
