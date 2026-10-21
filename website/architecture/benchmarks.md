# Benchmarks

The benchmarks live in `benchmarks/` as their own package, `@cortex/benchmarks`. The numbers here
are copied from its
[README](https://github.com/lktiep/cortex-hub/blob/master/benchmarks/README.md), which has the
method, the flags and the full logs.

## Code search: vector, BM25 and hybrid

`benchmarks/retrieval_bench.ts` runs 15 hand-written questions against this repo's own index, each
with the file that answers it. Embedder `all-minilm`.

| Mode | r@1 | r@3 | r@5 | r@10 | MRR | Cost per query |
|---|---:|---:|---:|---:|---:|---|
| vector | 0.533 | 0.667 | 0.800 | 1.000 | 0.656 | ~12 ms, 0 tokens |
| BM25 | 0.267 | 0.667 | 0.933 | 1.000 | 0.530 | ~8 ms, 0 tokens |
| **hybrid (RRF)** | **0.600** | **0.733** | 0.800 | 1.000 | **0.703** | ~8 ms, 0 tokens |
| vector + LLM rerank | no change to r@1 | | | | | +2.1 s, 1,359 tokens |
| `bge-m3` dense | worse than `all-minilm` | | | | | 226× the query latency |

Hybrid is what shipped: it was the only option that moved r@1. The right file is always in the
top ten, which is why the guides say to [read all ten hits](../guide/code-intelligence) rather than
search again.

```bash
pnpm --filter @cortex/benchmarks bench:retrieval -- --project <projectId>
```

## Memory search

`bench:mem9` measures `cortex_memory_search` ordering on 100 questions, `all-minilm`:

| Corpus | Mode | n | r@1 | r@5 | r@10 | MRR |
|---|---|---:|---:|---:|---:|---:|
| dev | vector | 24 | 0.917 | 1.000 | 1.000 | 0.951 |
| dev | **hybrid** | 24 | **1.000** | 1.000 | 1.000 | **1.000** |
| LongMemEval | vector | 100 | 0.450 | 0.800 | 0.890 | 0.601 |
| LongMemEval | **hybrid** | 100 | **0.550** | **0.870** | **0.900** | **0.685** |

Storing a memory (`add()`, 8 facts per call, LLM stubbed) went from a p50 of 1,430 ms to 248 ms
with the hybrid collection.

Run it against a throwaway Qdrant and Ollama, never a live hub.

## Knowledge search: LongMemEval-S

`bench:longmemeval` imports the sessions of the cleaned LongMemEval-S set into one project, then
asks all 500 questions against it.

| | R@5 | R@10 |
|---|---:|---:|
| Cortex Hub, hybrid | 96.0% | 97.8% |
| Cortex Hub, vector only | 93.8% | 97.0% |
| MemPalace, published baseline (OpenAI embeddings) | 96.6% | 98.2% |

::: warning
These runs date from April 2026 and used an in-process MiniLM embedder that has since been
removed; embeddings now go through the hub's LLM gateway to Ollama. The README also reports an
NDCG@10 above 1, which a normalized metric cannot reach, so that column is left out here.
:::

## Roadmap

ConvoMem, LoCoMo and MemBench are listed in the README as planned, not implemented.
