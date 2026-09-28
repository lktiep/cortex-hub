<!-- cortex-hub:auto-mcp -->
## Cortex Hub — Auto MCP (MANDATORY)

At the START of every conversation:
1. Call `cortex_session_start` with repo: "https://github.com/lktiep/cortex-hub.git", agentId: "cursor", mode: "development"
2. If `recentChanges.count > 0`, warn user and run `git pull`
3. `cortex_knowledge_search` + `cortex_memory_search` once — recall what the last session decided

### Finding code — start from what you know, not from a fixed ladder
| You already know | Start with |
|---|---|
| A symbol name | `cortex_code_context(name)` — exact graph lookup, plus callers/callees/imports in one call |
| Only the behaviour | `cortex_code_search(query, limit: 10)` — ranked hybrid search, one call |
| An exact literal (env var, config key, error string) | `rg` / `grep` — this is not a ranking problem |
| A relationship across files | `cortex_cypher` |

**Search once, read all ten.** On the cortex-hub index the target file is in the top 10 for
15/15 queries but at rank 1 for only 8/15 — so scan the whole result set, and never re-run a
reworded version of the same query. Ask a different question or switch tool instead.

`cortex_code_impact` before editing something exported or shared. Knowledge and memory are
for errors and decisions, not for locating code.

**Across repos:** omit `repo:` to search every repo in the organization of this project
(the client + server + tools of one product). Projects are isolated per organization, so it never reaches
another one. Running sessions in two organizations with one API key? Pass `org:`.

### Error Protocol
1. `cortex_knowledge_search` first — someone may have solved this
2. `cortex_memory_search` — you may have seen it before
3. Fix the error
4. Non-obvious fixes: `cortex_knowledge_store`

### Quality Gates
Run verify commands from `.cortex/project-profile.json`, then `cortex_quality_report`.
After a push: `cortex_code_reindex`. End session: `cortex_session_end` with sessionId and summary.
<!-- cortex-hub:auto-mcp -->
