# Cortex Hub — Current State

> Auto-read by agents at session start. Update at session end.

## Active Phase
- **Phase:** 6 (Polish, docs, testing, GA release)
- **Gate Passed:** Gate 5 (Phase 5→6) on 2026-03-19

## Current Task — Service Separation (dashboard-api ↔ hub-mcp)
- [x] Separate dashboard-api and hub-mcp into 2 independent services
- [x] Remove setInternalFetch hack — hub-mcp now calls dashboard-api via HTTP
- [x] Create Dockerfile.hub-mcp (standalone, lightweight)
- [x] Update docker-compose.yml: cortex-api (port 4000) + cortex-mcp (port 8317)
- [x] Build ✅ | Typecheck ✅ | Lint ✅

## Architecture — 2-Service Model
- **cortex-api** (port 4000): Dashboard API + Dashboard Web static files
- **cortex-mcp** (port 8317): MCP Gateway (standalone, calls cortex-api over Docker network)
- hub-mcp uses `DASHBOARD_API_URL=http://cortex-api:4000` for real HTTP calls

## MCP Server Status ✅
- **Endpoint:** `POST https://cortex-mcp.jackle.dev/mcp`
- **Auth:** Bearer token (`sk_ctx_...`)
- **9 tools operational:** cortex_health, cortex_memory_store, cortex_memory_search, cortex_knowledge_search, cortex_code_search, cortex_code_impact, cortex_code_reindex, cortex_quality_report, cortex_session_start
- **Transport:** Streamable HTTP (WebStandardStreamableHTTPServerTransport)
- **Agent workflow:** session.start → code.search → implement → quality.report

### Missing Tools (Backlog)
- `cortex.knowledge.store` — Agent contribute knowledge to Qdrant

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
- [x] Fix self-fetch deadlock: apiCall + setInternalFetch for in-memory routing (`bba043d`)
- [x] Service separation: split All-in-One into cortex-api + cortex-mcp

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
- [x] **Service Separation: cortex-api + cortex-mcp (2 containers)**
- [x] Providers page (multi-provider LLM config UI)
- [x] Mobile-Responsive Dashboard UI (hamburger sidebar, 3-tier breakpoints)

## Recent Decisions
- **Service separation:** dashboard-api and hub-mcp now run as separate Docker services. hub-mcp calls dashboard-api via real HTTP (`DASHBOARD_API_URL`). No more `setInternalFetch` hack.
- **Docker images:** `ghcr.io/lktiep/cortex-api` (dashboard-api) + `ghcr.io/lktiep/cortex-mcp` (hub-mcp)
- MCP handler uses `WebStandardStreamableHTTPServerTransport` (stateless, enableJsonResponse)
- Onboard script: uses user-provided MCP URL as-is (no suffix), tests connection before proceeding
- Mobile responsive: hamburger toggle + backdrop overlay at ≤768px, CSS-only breakpoints at 3 tiers

## Quality Status
- Build ✅ | Typecheck ✅ | Lint ✅ (Verified 2026-03-22T21:36+07:00)
- Architecture: 2-service model (cortex-api + cortex-mcp)
- MCP: 9 tools, hub-mcp as standalone service
