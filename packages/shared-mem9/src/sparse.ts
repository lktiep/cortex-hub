/**
 * Lexical (BM25) sparse vectors, the second arm of hybrid code search.
 *
 * A dense embedding can only answer "is this similar to the question". It cannot
 * answer "does this contain the identifier that was typed", which is most of
 * what a coding agent actually asks. Measured on this repo's own index, the
 * vector arm put the right file in the top 10 every single time but first only
 * 73% of the time — retrieval was never the weak part, ordering was. Fusing a
 * BM25 arm into the same query moved top-1 to 80% and MRR from 0.807 to 0.869,
 * for zero tokens and about a millisecond.
 *
 * Qdrant applies the IDF factor itself when the sparse vector is declared with
 * `modifier: 'idf'`, so a document vector here carries only the other half of
 * BM25: the term frequency, saturated and normalised by document length. A query
 * vector carries a flat 1.0 per term and lets Qdrant supply the weight.
 */

/**
 * The name the lexical arm is stored under. Index time and query time have to
 * agree on it, and a collection cannot be given a sparse vector after the fact,
 * so it is spelled exactly once.
 */
export const SPARSE_VECTOR_NAME = 'text'

/** Term-frequency saturation. Above this, more repetitions barely count. */
export const BM25_K1 = 1.2
/** How much document length is held against a match. */
export const BM25_B = 0.75

export interface SparseVector {
  indices: number[]
  values: number[]
}

/**
 * Split code into search terms.
 *
 * `resolveRepoNames` has to be findable by "resolve", by "repo", by "names" and
 * by its whole self, so the identifier is kept alongside its parts. Punctuation
 * and single characters carry no signal in code and are dropped; so are bare
 * numbers, which are mostly array indices and line numbers.
 */
export function tokenizeCode(text: string): string[] {
  const tokens: string[] = []

  for (const word of text.split(/[^A-Za-z0-9_]+/)) {
    if (!word) continue

    const whole = word.toLowerCase()
    if (whole.length > 1 && !/^\d+$/.test(whole)) tokens.push(whole)

    // snake_case, then camelCase and PascalCase, keeping acronym runs whole:
    // `parseHTTPResponse` → `parse`, `http`, `response`.
    const parts = word
      .split('_')
      .flatMap((p) => p.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))

    if (parts.length < 2) continue
    for (const part of parts) {
      const token = part.toLowerCase()
      if (token.length > 1 && token !== whole && !/^\d+$/.test(token)) tokens.push(token)
    }
  }

  return tokens
}

/**
 * FNV-1a, 32 bits — Qdrant indexes sparse dimensions by u32.
 *
 * Two different terms can land on the same dimension. At this corpus size that
 * is rare enough to cost nothing measurable, and the alternative is shipping a
 * vocabulary that has to stay in sync with the index.
 */
export function hashToken(token: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function termFrequencies(tokens: string[]): Map<number, number> {
  const counts = new Map<number, number>()
  for (const token of tokens) {
    const index = hashToken(token)
    counts.set(index, (counts.get(index) ?? 0) + 1)
  }
  return counts
}

/**
 * The stored half of BM25: tf saturated by k1 and normalised by how much longer
 * this document is than the average one.
 */
export function documentSparseVector(text: string, averageLength: number): SparseVector {
  const tokens = tokenizeCode(text)
  const counts = termFrequencies(tokens)

  // An empty corpus average would divide by zero; fall back to this document.
  const avg = averageLength > 0 ? averageLength : tokens.length || 1
  const norm = BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / avg)

  const indices: number[] = []
  const values: number[] = []
  for (const [index, tf] of counts) {
    indices.push(index)
    values.push((tf * (BM25_K1 + 1)) / (tf + norm))
  }

  return { indices, values }
}

/** The asked half: one flat unit per distinct term, weighted by Qdrant's IDF. */
export function querySparseVector(text: string): SparseVector {
  const indices = [...new Set(tokenizeCode(text).map(hashToken))]
  return { indices, values: indices.map(() => 1) }
}

/** Mean token count across a corpus — the `avgdl` that BM25 normalises against. */
export function averageTokenLength(texts: string[]): number {
  if (texts.length === 0) return 0
  let total = 0
  for (const text of texts) total += tokenizeCode(text).length
  return total / texts.length
}
