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
  const promise = (async () => {
    // Dynamic import — keeps @huggingface/transformers as an optional runtime dep.
    // We use @huggingface/transformers (v4+) instead of @xenova/transformers
    // because the newer package drops the eager `sharp` dependency that broke
    // text-only Linux deployments.
    const transformers = await import('@huggingface/transformers') as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<FeatureExtractionPipeline>
      env?: { allowLocalModels?: boolean; useBrowserCache?: boolean; useFSCache?: boolean }
    }

    if (transformers.env) {
      transformers.env.allowLocalModels = false
      transformers.env.useBrowserCache = false
      transformers.env.useFSCache = true
    }

    // dtype 'quantized' maps to model_quantized.onnx (smallest, ~25MB for MiniLM)
    // 'q8' maps to model_q8.onnx which doesn't ship for all models — caused
    // 'Unable to get model file path or buffer' error on the all-MiniLM-L6-v2 case.
    const pipe = await transformers.pipeline('feature-extraction', modelId, {
      dtype: 'quantized',
    })
    return pipe
  })()

  loadPromise = promise

  // CRITICAL: clear cached state on failure so the next call retries fresh
  // (otherwise a single transient error poisons the singleton forever)
  promise
    .then((pipe) => {
      pipelineSingleton = pipe
      loadPromise = null
    })
    .catch(() => {
      currentModelId = null
      loadPromise = null
    })

  return promise
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
  // Known dimensions for common models (works for both Xenova/* and HF org/* names)
  const knownDims: Record<string, number> = {
    'Xenova/all-MiniLM-L6-v2': 384,
    'Xenova/all-MiniLM-L12-v2': 384,
    'Xenova/bge-small-en-v1.5': 384,
    'Xenova/bge-base-en-v1.5': 768,
    'Xenova/multilingual-e5-small': 384,
    'sentence-transformers/all-MiniLM-L6-v2': 384,
    'mixedbread-ai/mxbai-embed-xsmall-v1': 384,
    'BAAI/bge-small-en-v1.5': 384,
    'BAAI/bge-base-en-v1.5': 768,
  }
  return knownDims[modelId] ?? 384
}
