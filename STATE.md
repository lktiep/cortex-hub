# Cortex Hub — Current State

> Auto-read by agents at session start. Update at session end.

## Active Phase
- **Phase:** 6 (Polish, docs, testing, GA release)
- **Gate Passed:** Gate 5 (Phase 5→6) on 2026-03-19

## Next Task — Mobile-Responsive UI
- [ ] Sidebar hamburger toggle + overlay (≤768px)
- [ ] DashboardLayout responsive margin/padding
- [ ] globals.css responsive tokens (breakpoints: ≤1024, ≤768, ≤480)
- [ ] Page-level breakpoint polish (keys/, setup/, usage/, providers/)

**Implementation plan:** Reviewed and approved. See `implementation_plan.md` in conversation `903f6fc6`.

## MCP Server Status ✅
- **Endpoint:** `POST https://cortex-mcp.jackle.dev/mcp`
- **Auth:** Bearer token (`sk_ctx_...`)
- **8 tools operational:** health, memory.store, memory.search, knowledge.search, code.search, code.impact, quality.report, session.start
- **Agent workflow:** session.start → code.search → implement → quality.report

### Missing Tools (Backlog)
- `cortex.code.reindex` — Notify server of new push, trigger GitNexus re-index
- `cortex.knowledge.store` — Agent contribute knowledge to Qdrant
- These will enable agents to keep knowledge up-to-date after code changes

## In Progress
- [x] MCP auth + handler fix chain (5 bugs fixed in `3df37dd`)
- [x] Onboarding: `mcp-remote` + URL as-is + connection test
- [x] Uninstall script + bootstrap option
- [x] Lefthook YAML key fix

## Completed (Phase 6)
- [x] Dashboard API — 9 real routes (no stubs)
- [x] Dashboard Web — 8 pages, full-featured
- [x] LLM API Gateway (multi-provider fallback, budget, usage logging)
- [x] Usage page rewired to real `/api/usage` endpoints
- [x] GitNexus indexing pipeline (clone → analyze → mem0 ingest)
- [x] Branch-scoped knowledge (mem0 user_id namespacing, fallback chain)
- [x] MCP branch-aware tools (code.search/impact with branch param)
- [x] Universal Installation & Onboarding (bootstrap.sh → onboard.sh)
- [x] API Key Persistence (SQLite + SWR + permissions)
- [x] All-in-One Docker Hub (dashboard-api + hub-mcp + dashboard-web)
- [x] Providers page (multi-provider LLM config UI)

## Recent Decisions
- MCP handler uses in-memory transport with auto-initialize handshake per request
- Onboard script: uses user-provided MCP URL as-is (no suffix), tests connection before proceeding
- Hono stays for hub-mcp (consistent with dashboard-api, runs native on Node.js)
- Uninstall cleans: mcp_config entry, .cortex/, lefthook, HUB_API_KEY

## Quality Status
- Build ✅ | Typecheck ✅ | Lint ✅ | Test ✅ (Verified 2026-03-22T14:00+07:00)
- Docker ✅ (commit `3df37dd` deployed via Watchtower)
- All services healthy via Cloudflare Tunnel
