# Cortex Hub — Current State

> Auto-read by agents at session start. Update at session end.

## Active Phase
- **Phase:** 6 (Polish, docs, testing, GA release)
- **Gate Passed:** Gate 5 (Phase 5→6) on 2026-03-19

## Current Task — MCP Streamable HTTP Transport
- [x] Identify root cause: `mcp-remote` needs Streamable HTTP (GET SSE + POST JSON-RPC), server only supported stateless POST
- [x] Replace custom JSON-RPC handler with `WebStandardStreamableHTTPServerTransport` from SDK
- [x] Build ✅ | Typecheck ✅ | Lint ✅ | Test ✅
- [x] Commit `6b0fbe4` + push to deploy
- [x] Verify Watchtower picks up new image and `mcp-remote` can connect — confirmed all services healthy via `cortex_health`

## MCP Server Status ✅
- **Endpoint:** `POST https://cortex-mcp.jackle.dev/mcp`
- **Auth:** Bearer token (`sk_ctx_...`)
- **9 tools operational:** cortex_health, cortex_memory_store, cortex_memory_search, cortex_knowledge_search, cortex_code_search, cortex_code_impact, cortex_code_reindex, cortex_quality_report, cortex_session_start
- **Transport:** Streamable HTTP (WebStandardStreamableHTTPServerTransport) — supports GET (SSE) + POST (JSON-RPC)
- **Agent workflow:** session.start → code.search → implement → quality.report

### Missing Tools (Backlog)
- `cortex.knowledge.store` — Agent contribute knowledge to Qdrant
- Session start hangs on deploy — needs investigation (timeout or transport issue)

## In Progress
- [x] MCP auth + handler fix chain (5 bugs fixed in `3df37dd`)
- [x] Onboarding: `mcp-remote` + URL as-is + connection test
- [x] Uninstall script + bootstrap option
- [x] Lefthook YAML key fix
- [x] Mobile-Responsive UI (6 files, committed `56b8dbb`)
- [x] MCP Streamable HTTP transport fix (`6b0fbe4`)
- [x] MCP tool name fix: dot → underscore (`8e6e50b`)
- [x] Docker Node 24 + corepack upgrade (`dc963ad`)
- [x] Docker build fix: add python3/make/g++ to builder (`6bc87f7`)
- [x] mem0→mem9 migration + fix all MCP tools (`8ffb854`)
- [x] Docker build optimization: cache mounts + shared base + .dockerignore (`35848b5`)
- [x] session_start: real DB records + project context (`85e0fd7`)
- [x] cortex_code_reindex tool + project lookup route (`0c0c45a`)

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
- [x] Mobile-Responsive Dashboard UI (hamburger sidebar, 3-tier breakpoints)

## Recent Decisions
- MCP handler now uses `WebStandardStreamableHTTPServerTransport` (stateless, enableJsonResponse) instead of custom Promise-based transport
- Onboard script: uses user-provided MCP URL as-is (no suffix), tests connection before proceeding
- Hono stays for hub-mcp (consistent with dashboard-api, runs native on Node.js)
- Uninstall cleans: mcp_config entry, .cortex/, lefthook, HUB_API_KEY
- Mobile responsive: hamburger toggle + backdrop overlay at ≤768px, CSS-only breakpoints at 3 tiers

## Quality Status
- Build ✅ | Typecheck ✅ | Lint ✅ (Verified 2026-03-22T16:44+07:00)
- Docker: `0c0c45a` deploying via Watchtower
- MCP: 9 tools operational, mem9 healthy
