import { describe, expect, it } from 'vitest'
import { isEmbeddingModel } from './embedding-models.js'

describe('isEmbeddingModel', () => {
  it('recognises models named after embeddings', () => {
    for (const id of ['text-embedding-3-small', 'gemini-embedding-001', 'nomic-embed-text:latest', 'mxbai-embed-large', 'embed-english-v3.0', 'Qwen/Qwen3-Embedding-0.6B']) {
      expect(isEmbeddingModel(id), id).toBe(true)
    }
  })

  it('recognises embedding families whose names never say embed', () => {
    for (const id of ['bge-m3', 'BAAI/bge-large-en-v1.5', 'intfloat/multilingual-e5-large', 'thenlper/gte-base', 'all-minilm:l6-v2', 'sentence-transformers/all-MiniLM-L6-v2', 'voyage-3']) {
      expect(isEmbeddingModel(id), id).toBe(true)
    }
  })

  it('leaves chat models and rerankers alone', () => {
    for (const id of ['gpt-4o', 'gemini-2.5-flash', 'qwen2.5-coder:7b', 'claude-sonnet-5', 'llama3.1:8b', 'BAAI/bge-reranker-v2-m3', 'rerank-english-v3.0', 'phi-3.5-mini']) {
      expect(isEmbeddingModel(id), id).toBe(false)
    }
  })
})
