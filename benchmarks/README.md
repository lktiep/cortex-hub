# Cortex Hub Benchmarks

Reproducible retrieval-quality benchmarks for Cortex Hub's knowledge layer.
This directory is a standalone pnpm workspace package (`@cortex/benchmarks`)
so that benchmark dependencies stay out of the main build.

## What we benchmark

| Benchmark       | What it measures                                                 | Status      |
| --------------- | ---------------------------------------------------------------- | ----------- |
| LongMemEval-S   | `cortex_knowledge_search` retrieval quality (R@5 / R@10 / NDCG)  | Implemented |
| ConvoMem        | Conversational memory recall over long dialogues                 | Roadmap     |
| LoCoMo          | Long conversation memory recall                                  | Roadmap     |
| MemBench        | Broad memory stress-test across tasks                            | Roadmap     |

The goal is to produce numbers that are directly comparable with published
baselines so we can track Cortex's knowledge layer against the state of the
art.

## LongMemEval — methodology

The benchmark uses the cleaned LongMemEval-S dataset published by
`xiaowu0162/longmemeval-cleaned` on Hugging Face. Each question comes with a
"haystack" of sessions (arrays of messages) and the `session_id` of the
session that contains the answer.

For every question we:

1. Delete any prior bench documents in project `longmemeval-bench`.
2. Import every haystack session into Cortex via `POST /api/knowledge`
   with `title = session_id`, `content = "role: text\n\nrole: text..."`,
   `projectId = longmemeval-bench`, and tag `longmemeval`.
3. Run `POST /api/knowledge/search` with the question text, scoped to the
   same project, limit 10.
4. Translate the returned `documentId`s back to the session IDs we imported
   and compute:

   - **R@5** — 1 if the gold session appears in the top 5 results, else 0
   - **R@10** — same for top 10
   - **NDCG@10** — standard binary-relevance NDCG truncated at 10
   - **MRR** — mean reciprocal rank of the first hit

5. Delete the imported documents before moving to the next question so
   every question starts with a clean haystack (this matches the LongMemEval
   per-question evaluation protocol).

The compare baseline is MemPalace's published score of **96.6% R@5** on
LongMemEval. If Cortex is within ~5 points of that and ahead on NDCG, we
consider the retrieval layer competitive.

## How to run

From the repo root:

```bash
# Install workspace deps (only needed once after adding benchmarks/)
pnpm install

# Small smoke run (50 questions) against local API
pnpm --filter @cortex/benchmarks bench:longmemeval --limit 50 --api-url http://localhost:4000

# Full run
pnpm --filter @cortex/benchmarks bench:longmemeval --api-url http://localhost:4000

# Clean up any leftover bench documents
pnpm --filter @cortex/benchmarks bench:longmemeval --cleanup
```

You can also run it directly from this directory:

```bash
cd benchmarks
pnpm bench:longmemeval --limit 50
```

Prerequisites:

- Cortex API running on `http://localhost:4000` (configurable via `--api-url`).
- A working embedder — either `GEMINI_API_KEY` set in the API process env or a
  `provider_accounts` row of type `gemini` with `status = 'enabled'`.
- Qdrant reachable from the API (defaults to `http://qdrant:6333` in Docker
  Compose).

On the first run the dataset (~100 MB) is downloaded to
`benchmarks/data/longmemeval_s_cleaned.json` and cached; subsequent runs
reuse the cached copy.

## CLI reference

```
pnpm bench:longmemeval [--limit N] [--api-url URL] [--cleanup] [--skip-import] [--verbose]
```

| Flag              | Description                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| `--limit N`       | Only evaluate the first `N` questions. Useful for smoke runs.                       |
| `--api-url URL`   | Cortex API base URL. Defaults to `http://localhost:4000`.                           |
| `--cleanup`       | Delete every knowledge document in `projectId=longmemeval-bench` and exit.          |
| `--skip-import`   | Assume the sessions have already been imported. Falls back to title matching.      |
| `--verbose`       | Log import failures per session.                                                    |

## Expected runtime

Runtime is dominated by Gemini embedding calls — each session is chunked and
embedded on import, and each question issues one embedding call on search.

| Questions | Approx. sessions | Wall clock                         |
| --------- | ---------------- | ---------------------------------- |
| 50        | ~2,500           | 5–10 minutes                       |
| Full (~500) | ~25,000        | 45–75 minutes                      |

If you see timeouts or rate-limit errors, drop `--limit` and/or add a larger
`GEMINI_API_KEY` quota.

## Interpreting results

The benchmark prints a markdown results table and writes a JSON file to
`benchmarks/results/longmemeval_<timestamp>.json`. The JSON file contains
per-question outcomes so you can drill into misses.

Headline metrics:

- **R@5 ≥ 0.95** — parity with MemPalace.
- **R@5 0.85–0.95** — competitive; worth tuning chunking / re-ranking.
- **R@5 < 0.85** — regression; investigate embedder, chunk sizes, or hybrid
  re-ranking weights in `apps/dashboard-api/src/routes/knowledge.ts`.

NDCG@10 matters more when tuning the re-ranker: improvements in top-1
placement show up there before they show up in R@5.

## Results log

Fill in after each run. Keep it short — full details live in
`benchmarks/results/`.

| Date       | Cortex version | Dataset slice | R@5   | R@10  | NDCG@10 | Notes                                |
| ---------- | -------------- | ------------- | ----- | ----- | ------- | ------------------------------------ |
| _pending_  | v0.5.30        | limit 50      | _TBD_ | _TBD_ | _TBD_   | Initial baseline run against staging |

## Roadmap

- **ConvoMem** — conversational memory benchmark with multi-turn follow-ups.
- **LoCoMo** — long-conversation memory over tens of thousands of tokens.
- **MemBench** — general-purpose memory stress tests across task types.

All of the above will reuse the same `POST /api/knowledge/search` surface so
that benchmark scores remain comparable to LongMemEval.
