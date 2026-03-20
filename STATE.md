# Cortex Hub — Current State

> Auto-read by agents at session start. Update at session end.

## Active Phase
- **Phase:** 6 (Polish, docs, testing, GA release)
- **Gate Passed:** Gate 5 (Phase 5→6) on 2026-03-19

## In Progress
- [/] Indexing Pipeline — Code complete, needs Docker rebuild on server to go live
- [ ] Agent onboarding documentation
- [ ] GA release prep

## Completed (this session)
- [x] Dashboard Frontend (Next.js 15 + App Router)
- [x] Organizations + Projects CRUD
- [x] Setup Wizard with OAuth + API key flows
- [x] Private Git repos (Azure DevOps, GitHub PAT)
- [x] GitNexus indexing pipeline (clone → analyze → mem0 ingest)
- [x] Real-time IndexingPanel UI (progress bar, branch selector, history)
- [x] Custom workflow system (STATE.md + AGENTS.md + project-profile.json verify)
- [x] Agent quality strategy doc archived to docs/architecture/
- [x] Project-profile.json verify section (pre_commit, full, deploy commands)

## Recent Decisions
- 2026-03-20: `project-profile.json` → `verify` section as single source of truth for CI commands
- 2026-03-20: Custom workflow system (STATE.md + natural language triggers) over Forgewright
- 2026-03-20: GitNexus v1.4.7 for AST indexing, mem0 for knowledge memory
- 2026-03-19: Private repos via username/PAT injected into git clone URL
- 2026-03-19: Cloudflare Pages production = `main` branch (not `master`)

## Blockers
- Server Docker rebuild needed for indexing pipeline

## Verify Commands (from project-profile.json)
```bash
# Pre-commit (quick — run after every code change)
pnpm build --filter='@cortex/shared-*'
pnpm typecheck
pnpm lint

# Full (before deploy)
pnpm build --filter='@cortex/shared-*'
pnpm typecheck
pnpm lint
pnpm test
```
