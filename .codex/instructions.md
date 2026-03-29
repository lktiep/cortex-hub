<!-- cortex-hub:auto-mcp -->
## Cortex Hub — Auto MCP (MANDATORY)

At the START of every conversation:
1. Call `cortex_session_start` with repo: "https://github.com/lktiep/cortex-hub.git", agentId: "codex", mode: "development"
2. If `recentChanges.count > 0`, warn user and run `git pull`
3. Read `STATE.md` if it exists

### Error Protocol
1. `cortex_knowledge_search` first
2. Fix the error
3. Non-obvious fixes: `cortex_knowledge_store`

### Quality Gates
Run verify commands from `.cortex/project-profile.json`, then `cortex_quality_report`.
End session: `cortex_session_end` with sessionId and summary.
<!-- cortex-hub:auto-mcp -->
