# Cortex Hub Benchmarks

Reproducible retrieval-quality benchmarks for Cortex Hub's knowledge layer.
This directory is a standalone pnpm workspace package (`@cortex/benchmarks`)
so that benchmark dependencies stay out of the main build.

## What we benchmark

| Benchmark       | What it measures                                                 | Status      |
| --------------- | ---------------------------------------------------------------- | ----------- |
| LongMemEval-S   | `cortex_knowledge_search` retrieval quality (R@5 / R@10 / NDCG)  | Implemented |
| Code retrieval  | `cortex_code_search` ordering: vector vs BM25 vs RRF hybrid       | Implemented |
| Mem9 memory     | `cortex_memory_search` ordering, and what `add()` costs           | Implemented |
| Reranking       | Whether an LLM reranker improves that ordering                    | Implemented |
| ConvoMem        | Conversational memory recall over long dialogues                 | Roadmap     |
| LoCoMo          | Long conversation memory recall                                  | Roadmap     |
| MemBench        | Broad memory stress-test across tasks                            | Roadmap     |

## LongMemEval — methodology

The benchmark uses the cleaned LongMemEval-S dataset published by
`xiaowu0162/longmemeval-cleaned` on Hugging Face. Each question comes with a
"haystack" of sessions and the `session_id` of the answer.

### How it works

1. **Import phase (one-time)**: All unique sessions across all questions are
   imported into a single Cortex project (`longmemeval-bench`). This mirrors
   real-world usage — you index your knowledge base once, then query many times.

2. **Search phase**: Each question is searched against the full corpus.
   No per-question import/delete — just pure search performance.

3. **Cleanup**: All benchmark documents are removed after the run.

Metrics computed per question:
- **R@5** — gold session in top 5 results
- **R@10** — gold session in top 10 results
- **NDCG@10** — normalized discounted cumulative gain at 10
- **MRR** — mean reciprocal rank of the first hit

## Results

### Cortex vs MemPalace — head to head

| | Cortex Hub | MemPalace |
|---|---|---|
| **R@5** | **96.0%** | 96.6% |
| **R@10** | **97.8%** | 98.2% |
| **NDCG@10** | **1.443** | 0.889 |
| **Embedding** | Local (in-process) | OpenAI API |
| **Cost** | **$0** | ~$2-5/run |
| **API key required** | **No** | Yes (OpenAI) |
| **Embedding speed** | **~10ms/text** | ~600ms/text |
| **Network required** | **No (fully offline)** | Yes |
| **Server cost** | $4.50/mo VPS | $4.50/mo VPS + API fees |

Cortex matches MemPalace within 0.6 points on R@5 while being **completely free,
offline, and 60x faster per embedding**. NDCG@10 is 62% higher — when Cortex
finds the answer, it places it at rank 1, not just somewhere in top 5.

MemPalace requires an OpenAI API key and pays per embedding call. Cortex runs
the embedding model in-process via `@huggingface/transformers` — zero network,
zero cost, zero rate limits.

### Detailed results (full 500 questions, local embedder + hybrid re-rank)

| Type | N | R@5 | R@10 | NDCG@10 |
|---|---:|---:|---:|---:|
| knowledge-update | 78 | 98.7% | 100% | 1.65 |
| multi-session | 133 | 98.5% | 100% | 1.79 |
| single-session-user | 70 | 97.1% | 97.1% | 0.98 |
| temporal-reasoning | 133 | 94.7% | 97.0% | 1.56 |
| single-session-assistant | 56 | 94.6% | 94.6% | 0.98 |
| single-session-preference | 30 | 83.3% | 93.3% | 0.78 |

### Performance

| Metric | Value |
|---|---|
| Search duration (500 queries) | **52.6s** |
| Avg latency per query | **105ms** |
| Import (19K sessions, one-time) | ~15 min |
| Embedder | `Xenova/all-MiniLM-L6-v2` (384-dim, local) |
| Server | 4 vCPU / 12GB RAM, no GPU |

### Results log

| Date | Version | Embedder | Ranking | R@5 | R@10 | NDCG@10 | Search time | Notes |
|---|---|---|---|---|---|---|---|---|
| 2026-04-11 | v0.7.0 | local MiniLM (384d) | hybrid | 96.0% | 97.8% | 1.443 | 52.6s | **Current — import once, query many** |
| 2026-04-09 | v0.5.55 | local MiniLM (384d) | hybrid | 96.0% | 97.8% | 1.443 | 20.7m | Old method (import/delete per question) |
| 2026-04-09 | v0.5.52 | local MiniLM (384d) | vector only | 93.8% | 97.0% | 1.363 | 20.7m | Pre-rerank baseline |
| - | - | OpenAI (1536d) | - | 96.6% | 98.2% | 0.889 | ~5 min | MemPalace published baseline |

## How to run

```bash
# Install deps (once)
pnpm install

# Full run (500 questions)
pnpm --filter @cortex/benchmarks bench:longmemeval --api-url http://localhost:4000

# Smoke run (50 questions)
pnpm --filter @cortex/benchmarks bench:longmemeval --limit 50

# Clean up leftover bench documents
pnpm --filter @cortex/benchmarks bench:longmemeval --cleanup
```

### CLI flags

| Flag | Description |
|---|---|
| `--limit N` | Only evaluate first N questions |
| `--offset N` | Skip first N questions |
| `--api-url URL` | Cortex API base URL (default: `http://localhost:4000`) |
| `--cleanup` | Delete all bench documents and exit |
| `--skip-import` | Assume sessions already imported |
| `--stratified` | Sample equally from each question type |
| `--verbose` | Log per-question results during search |

### Prerequisites

- Cortex API running (configurable via `--api-url`)
- Local embedder enabled (`EMBEDDING_PROVIDER=local`, default)
- Qdrant reachable from the API

Dataset (~100 MB) is auto-downloaded and cached on first run.

## Code retrieval — vector vs BM25 vs hybrid

`retrieval_bench.ts` answers one question: does fusing a lexical arm into code
search order results better than the vector arm alone? Recall@10 on cortex-hub's
own index was already 1.000 while recall@1 was 0.533, so the gap to close was
ordering, not retrieval.

### How it works

1. **Corpus** — scrolls the chunks back out of a live `cortex-project-*`
   collection, so they are byte-for-byte the ones production serves. No
   re-chunking, no drift.
2. **Bench collection** — builds a throwaway collection carrying both arms
   (`vectors` + `sparse_vectors: {text: {modifier: 'idf'}}`), embedding with the
   production embedder and weighting with the production `documentSparseVector`.
   A collection is needed because Qdrant cannot add a sparse vector to one that
   already exists, so a project indexed before hybrid search landed cannot be
   measured in place.
3. **Three modes, same corpus and same query embedding** — dense search, sparse
   alone, and both arms merged by reciprocal rank fusion inside Qdrant.
4. **Cleanup** — the collection is deleted even if the run throws, unless
   `--keep`.

The gold set lives in `gold_code_search.ts` and is shared with the rerank bench.
It is **hand-written**, and deliberately so: generating queries from each chunk's
own leading comment produced 120 questions that rewarded literal matching, where
BM25 scored r@1 0.775 against vector's 0.533. That measures how the questions
were made, not how the retrievers rank.

### Results — cortex-hub's own index, `all-minilm`, n = 15

| Mode | r@1 | r@3 | r@5 | r@10 | MRR | Cost per query |
|---|---:|---:|---:|---:|---:|---|
| vector | 0.533 | 0.667 | 0.800 | 1.000 | 0.656 | ~12 ms, 0 tokens |
| bm25 | 0.267 | 0.667 | 0.933 | 1.000 | 0.530 | ~8 ms, 0 tokens |
| **hybrid (RRF)** | **0.600** | **0.733** | 0.800 | 1.000 | **0.703** | **~8 ms, 0 tokens** |
| vector + LLM rerank | no change to r@1 | — | — | — | — | +2.1 s, 1,359 tokens |
| bge-m3 dense | worse than all-minilm | — | — | — | — | 226x the query latency |

Hybrid is what shipped: it is the only option that moved r@1, and it costs a
second Qdrant prefetch arm rather than a model call. Per query it improved 3
orderings and regressed 0. Note that BM25 alone is the *worst* of the three at
r@1 — the win is in the fusion, not in the lexical arm, and anyone tempted to
replace vector search with BM25 on the strength of "keywords work better for
code" should read that row first. The LLM reranker does not move r@1 at all for
two seconds and 1.4k tokens per query, and is not even deterministic between runs
at temperature 0. bge-m3 is *worse* here despite being the larger model.

The dense numbers were cross-checked against `/points/search` on the live
production collection with the same 15 queries: identical rank for every query,
which is how the harness is known to measure the thing production serves rather
than an artefact of its own bench collection.

Hybrid needs a collection created with the sparse vector, so it activates on
re-index. Search reports which path served a query as `retrieval: 'hybrid' |
'vector'` — a collection indexed before this landed keeps behaving exactly as it
did.

### How to run

```bash
# from inside the cortex-api container, where qdrant and ollama resolve
tsx retrieval_bench.ts --project <projectId>
tsx retrieval_bench.ts --project <projectId> --model bge-m3 --keep

# or against a local stack
pnpm --filter @cortex/benchmarks bench:retrieval -- --project <projectId>
```

| Flag | Description |
|---|---|
| `--project ID` | Which `cortex-project-<ID>` collection to read the corpus from (required) |
| `--model NAME` | Embedding model for the dense arm (default: `all-minilm`) |
| `--keep` | Leave the bench collection behind for inspection |

The per-query rank table it prints is the part worth reading: an average can stay
flat while a mode fixes as many orderings as it breaks.

## Mem9 memory — vector vs hybrid, and the cost of `add()`

`mem9_bench.ts` measures the memory engine behind `cortex_memory_search` and
`cortex_memory_store`, through `Mem9.search()` and `Mem9.add()` themselves —
recency blend included — so the numbers are the ones an agent gets.

### How it works

1. **Two corpora**, because they fail differently:
   - **longmemeval** — for each of 100 LongMemEval-S questions, every user turn
     of its haystack (~240) is stored as one user's memories: 24,216 in all.
     The turns marked as evidence are the answer. This is much harder than the
     session-level benchmark above: the target is one turn among hundreds of
     turns from the same person, not a session among sessions.
   - **dev** — `gold_memory_search.ts`: 36 short facts about a fictional
     codebase, a third of them Vietnamese, many carrying an identifier, with 24
     hand-written queries. What the hub actually stores, recalled through an
     English-only embedder.
2. **Seeded as production holds memories today**: one dense vector per point,
   the payload Mem9 writes, all with the same timestamp so recency is flat and
   only relevance decides the order.
3. **Then migrated**: `copyToHybridCollection` — the same code the production
   migration runs — copies the collection into one with the lexical arm, reusing
   the dense vectors, and every query runs again. `vector` and `hybrid` rows
   differ only in how memories are retrieved.
4. **`add()` timing** runs the real embed → search → write path against the
   same Qdrant with the LLM stubbed out, so it measures Mem9's own work around
   the two LLM calls, not the calls.

### Results — `all-minilm`, 100 questions

| Corpus | Mode | n | r@1 | r@3 | r@5 | r@10 | MRR | p50 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| dev | vector | 24 | 0.917 | 1.000 | 1.000 | 1.000 | 0.951 | 59 ms |
| dev | **hybrid** | 24 | **1.000** | 1.000 | 1.000 | 1.000 | **1.000** | 71 ms |
| longmemeval | vector | 100 | 0.450 | 0.710 | 0.800 | 0.890 | 0.601 | 62 ms |
| longmemeval | **hybrid** | 100 | **0.550** | **0.790** | **0.870** | **0.900** | **0.685** | 65 ms |

Per query, hybrid put the answer higher than vector for 30 LongMemEval questions
and lower for 6; on dev, 2 higher and none lower (`VNPay callback signature` 2 →
1, `reconcilePayments` 3 → 1 — both an identifier the embedder cannot read).
Like code search, the gain is almost all ordering: recall@10 barely moves, top-1
moves ten points. The dev set is small and was already easy for the vector arm;
LongMemEval is the number to trust. The `vector` rows are identical before and
after this change — a collection that has not been migrated behaves exactly as
it did.

Fusion is reciprocal rank (k = 60) done in Mem9 rather than in Qdrant, because
the result has to stay a relevance in [0, 1]: `search()` blends it with recency,
and the hub merges it with session summaries scored 1.0. When the lexical arm
matches nothing, or fails, the answer is the vector arm's with its cosine scores
intact.

The tokenizer is not the code one. `tokenizeCode` splits on anything outside
ASCII, which turns `đơn hàng` into `ơn`, `h`, `ng`; `tokenizeText` keeps Unicode
words, keeps numbers (a port or an amount is a fact in a memory), still splits
identifiers, and stores every accented word folded as well, so `don hang bi treo`
finds `Đơn hàng bị treo`.

### `add()` — 8 facts per call, LLM stubbed, old and new code interleaved

| Code | p50 | mean | p90 |
|---|---:|---:|---:|
| before | 1,430 ms | 1,393 ms | 1,853 ms |
| after, vector-only collection | 274 ms | 304 ms | 559 ms |
| after, hybrid collection | 248 ms | 288 ms | 649 ms |

The old path embedded each fact on its own, searched for it, and later embedded
the same text again to store it — sixteen embedding round trips and eight
searches, one after another, for eight facts. Now the facts go in one embedding request, the lookups run at once,
and an ADD reuses its fact's vector. With a real LLM the two model calls still
dominate `add()`; this is the ~1.1 s around them.

`add()` also checks the content hash it always stored but never read: stating
the same 8 facts again stored **0** new memories (the old code stored all 8 a
second time) and reported them as `NONE` with the id already holding them.

### How to run

```bash
# a throwaway Qdrant and Ollama — never a live hub
docker run -d --name mem9-bench-qdrant -p 16333:6333 qdrant/qdrant:v1.13.6
docker run -d --name mem9-bench-ollama -p 11435:11434 ollama/ollama
docker exec mem9-bench-ollama ollama pull all-minilm

QDRANT_URL=http://localhost:16333 OLLAMA_API_BASE=http://localhost:11435/v1 \
  pnpm --filter @cortex/benchmarks bench:mem9 -- --questions 100 --label after
```

| Flag | Description |
|---|---|
| `--questions N` | LongMemEval questions to include (default 100; 0 runs dev only) |
| `--model NAME` | Embedding model (default: `all-minilm`) |
| `--label NAME` | Tag for the result file in `results/` |
| `--keep` | Leave both bench collections behind |

LongMemEval questions read `data/longmemeval_s_cleaned.json`, which the
knowledge benchmark downloads on its first run; without it, pass
`--questions 0` for the dev corpus alone.

## Roadmap

- **ConvoMem** — conversational memory with multi-turn follow-ups
- **LoCoMo** — long-conversation memory over tens of thousands of tokens
- **MemBench** — general-purpose memory stress tests
- **Hierarchical search** — auto-clustering to improve large-corpus accuracy
