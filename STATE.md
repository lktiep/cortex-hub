# Cortex Hub — Current State

> Auto-read by agents at session start. Update at session end.

## Active Phase
- **Phase:** 6 (Polish, docs, testing, GA release)
- **Gate Passed:** Gate 5 (Phase 5→6) on 2026-03-19

## In Progress
- [/] Indexing pipeline testing on real repositories
- [/] Agent quality strategy documentation

## Completed (Phase 6)
- [x] Dashboard API — 9 real routes (no stubs)
- [x] Dashboard Web — 8 pages, full-featured
- [x] GitNexus indexing pipeline (clone → analyze → mem0 ingest)
- [x] Workflow system (conventions, per-project profiles)
- [x] Branch-scoped knowledge (mem0 user_id namespacing, fallback chain)
- [x] Enhanced IndexingPanel (branch dropdown, diff view, per-branch status, 1.5s realtime polling)
- [x] MCP branch-aware tools (memory.store/search + code.search/impact with projectId/branch)
- [x] 3 new backend endpoints (branches listing, diff, per-branch index summary)
- [x] Universal Installation & Onboarding (`install.sh`, `install-hub.sh`, `onboard.sh`)
- [x] Onboarding stabilization (non-interactive support, idempotent /onboard) ✅
- [x] API Key Persistence (SQLite + SWR + permissions) ✅
- [x] Cortex Skill Set integration (GSD + Forgewright Golden Standard)
- [x] Hub MCP Session Enforcement & Mission Briefs
- [x] mem0 Gemini Embedding Fallback (100% reliability)
- [x] Moved MCP Gateway to All-in-One Docker Hub (Node.js) ✅
- [x] Integrated Dashboard Web serving into Dashboard API ✅
- [x] Unified `Dockerfile.dashboard-api` for all-in-one deployment ✅
- [x] Updated `docker-compose.yml` (consolidated `cortex-hub` service) ✅
- [x] Docker rebuilt and deployed with latest code
## Recent Decisions
- mem0 branch scope: `project-{id}:branch-{name}` for branch, `project-{id}` for project fallback
- Branch diff uses `git diff --name-status origin/base...origin/branch`
- Branch listing via `git ls-remote --heads` (no cloning required)
- One-Command Philosophy: root `install.sh` for setup, `/onboard` for agent alignment
- Mission Briefs: session-start protocol for standard enforcement (SOLID, etc.)

## Quality Status
- Quality status: Build ✅ | Typecheck ✅ | Lint ✅ (Verified 2026-03-20T17:35+07:00)
- Docker ✅ (container recreated 2026-03-20T03:38Z)
- All 4 services healthy: qdrant, neo4j, cliproxy, mem0
