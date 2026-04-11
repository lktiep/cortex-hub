<!-- cortex-hub:auto-mcp -->
## Cortex Hub (MANDATORY)

At the START of every conversation:
1. `cortex_session_start` with repo: "https://github.com/lktiep/cortex-hub.git", agentId: "vscode-copilot", mode: "development"
2. If `recentChanges.count > 0`, warn user and `git pull`
3. `cortex_memory_search` + `cortex_knowledge_search` — recall previous session context

### During Work
Use cortex tools before grep/find: `code_search` → `code_impact` → `code_context`. Fall back to grep only if no results.

### Error Protocol
1. `cortex_knowledge_search` first — someone may have solved this
2. Fix the error
3. Non-obvious fixes: `cortex_knowledge_store` to save the solution

### Ending
1. Run verify: `pnpm build && pnpm typecheck && pnpm lint`
2. `cortex_quality_report` with results
3. `cortex_memory_store` — persist session learnings
4. `cortex_session_end` with sessionId and summary
<!-- cortex-hub:auto-mcp -->
