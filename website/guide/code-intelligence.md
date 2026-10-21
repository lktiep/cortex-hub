# Code intelligence

The hub indexes each repo into an AST graph (GitNexus) and a vector index (Qdrant). Agents query
both through MCP, so they can find code in any repo of their organization without cloning it.

## Pick the tool by what you already know

| You already know | Start with | Why |
|---|---|---|
| A symbol name (`buildHybridQuery`) | `cortex_code_context(name)` | Exact graph lookup. Callers, callees and imports in one call |
| Only the behaviour ("where do we verify API keys?") | `cortex_code_search(query, limit: 10)` | Ranked hybrid search over the index |
| An exact literal: env var, config key, error string | `rg` / `grep` | Not a ranking problem; the string is there or it is not |
| A relationship ("who calls X across packages") | `cortex_cypher` | One graph query instead of several searches |
| Whether someone else is in this file | `cortex_changes` | Before you edit anything shared |

This table is also what `/cs` tells the agent at the start of each session.

## Search once, then read all ten

On this repo's own index (`benchmarks/retrieval_bench.ts`, a hand-written set of 15 queries) the
target file is in the top 10 for 15 of 15 queries, in the top 3 for 11 and at rank 1 for 8. So:

- **Read the whole list before you choose.** Acting on hit #1 alone is wrong about four times in ten.
- **Don't reword the same question.** With recall@10 at 1.000, a paraphrase returns the same set.
  If nothing fits, ask a different question or switch tool.

`cortex_code_search` defaults to `limit: 5`; pass `limit: 10`. Its response says which
`retrieval` it used: `hybrid` (vector and BM25 fused with reciprocal rank fusion) or `vector`. A
repo gets hybrid search the next time it is re-indexed. The numbers behind the choice are in
[Benchmarks](../architecture/benchmarks).

## The tools

| Tool | Use it for |
|---|---|
| `cortex_code_search` | Find code by behaviour. `repo`, `branch`, `limit` |
| `cortex_code_context` | A symbol's definition, callers, callees and imports. `name`, optional `file` |
| `cortex_code_impact` | Blast radius before you change something exported. `direction`: `downstream` (default) or `upstream` |
| `cortex_detect_changes` | Symbols a diff touches, and a risk level |
| `cortex_cypher` | Raw Cypher over the graph. Nodes have `id`, `name`, `filePath`, `startLine`, `endLine`; use `labels(n)` for the kind |
| `cortex_list_repos` | The repos a cross-repo search covers |
| `cortex_code_reindex` | Re-index a repo and branch after a push |

Parameters for each are in the [MCP tools reference](../reference/mcp-tools#code).

## Across repos

Projects belong to an **organization**. Put a product's client, server and tools in the same one;
that is the boundary of a cross-repo search.

```
cortex_code_search(query: "login packet")                  # every repo in the organization
cortex_code_search(query: "user auth", repo: "my-backend")  # one repo
cortex_code_context(name: "validateToken", repo: "my-backend")
cortex_list_repos()                                         # what "every repo" covers
```

The organization comes from `org` if you pass it, else from the repo you named, else from your
latest `cortex_session_start` (its `project.orgId`). If you belong to several organizations and
none of those applies, the search is refused rather than widened.

## Before a commit, after a push

The hub cannot see your working tree, so `cortex_detect_changes` needs the diff:

```bash
git diff --staged
# for a large change, only the headers:
git diff --staged -U0 | grep -E '^(diff |--- |\+\+\+ |@@ )'
```

`risk_level: "unknown"` means a lookup failed, not that the change is safe.

After you push, `cortex_code_reindex(repo, branch)` keeps the graph current. Branch indexes are
dropped after `BRANCH_RETENTION_DAYS` (default 14) without a re-index, or when the branch is
merged or deleted.
