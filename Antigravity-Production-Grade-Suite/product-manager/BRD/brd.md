# Feature: Cortex Hub — The Neural Intelligence Platform

**Status:** Draft
**Date:** 2026-03-18
**Last Updated:** 2026-03-18

## Problem Statement

AI coding agents (Antigravity, GoClaw, etc.) currently operate in isolation — each with its own memory, each requiring individual codebase configuration, with no shared intelligence or session continuity. This leads to:
- Repeated discovery work across agents
- Lost context when switching between agents
- No centralized observability into agent activity
- Manual per-agent setup for each codebase
- No quality enforcement across sessions

**For:** Developers and teams using multiple AI coding agents on the same codebases.

## Proposed Solution

A self-hosted, MCP-compliant platform (Cortex Hub) that unifies:
1. **Code Intelligence** — all repos indexed in a shared knowledge graph (GitNexus)
2. **Persistent Memory** — cross-session, per-agent + shared memory (mem0 + Neo4j)
3. **Shared Knowledge** — agent-contributed, human-curated knowledge base (Qdrant)
4. **Quality Enforcement** — automated scoring and policy gates per session
5. **Session Handoff** — structured context transfer between agents
6. **Management Dashboard** — centralized admin UI for repos, API keys, logs, and quality trends

Exposed as a single MCP endpoint via Cloudflare Worker, with backend services running in Docker on a self-hosted server.

## User Stories

### Epic 1: MCP Gateway (P0)
- As an **AI agent**, I want to connect to a single MCP endpoint so that I can access all intelligence tools without individual service setup.
- As an **admin**, I want to authenticate agents via API keys so that I can control access and track usage.
- As an **agent**, I want tool calls logged with latency and status so that performance can be monitored.

### Epic 2: Code Intelligence (P0)
- As an **agent**, I want to search code semantically so that I can find relevant functions without knowing exact names.
- As an **agent**, I want to see the blast radius before editing a symbol so that I don't break callers.
- As an **agent**, I want to trace execution flows so that I understand how code paths connect.
- As an **admin**, I want to import GitHub repos (public + private) via the dashboard so that they get indexed automatically.

### Epic 3: Agent Memory (P0)
- As an **agent**, I want to store memories after each session so that I remember decisions made.
- As an **agent**, I want to recall memories by semantic similarity so that past context informs current work.
- As an **agent**, I want memory isolation per agent with optional shared spaces so that private context is protected.

### Epic 4: Knowledge Base (P1)
- As an **agent**, I want to auto-contribute discovered patterns so that knowledge accumulates.
- As an **admin**, I want to review and approve/reject contributed knowledge so that quality is maintained.
- As an **agent**, I want to search the knowledge base semantically so that I can find prior solutions.

### Epic 5: Quality Gates (P1)
- As an **agent**, I want to submit a quality report after each session so that my work is scored.
- As an **admin**, I want to see quality trends over time (per project) so that I can track standards.
- As a **system**, I want to enforce minimum quality thresholds so that low-quality output is flagged.

### Epic 6: Session Handoff (P1)
- As an **agent**, I want to create a handoff with context so that another agent can continue my work.
- As an **agent**, I want to claim pending handoffs so that I pick up where others left off.
- As a **system**, I want handoffs to auto-expire after 7 days so that stale work doesn't accumulate.

### Epic 7: Dashboard & Onboarding (P2)
- As an **admin**, I want to log in via GitHub OAuth so that setup is instant.
- As an **admin**, I want to create/revoke API keys per agent so that I control access granularly.
- As an **admin**, I want real-time logs streaming via WebSocket so that I can monitor agent activity live.
- As an **admin**, I want to see service health on an overview screen so that I know the system status.
- As an **admin**, I want usage analytics (per agent, per tool, error rates) so that I understand utilization.

## Acceptance Criteria

### MCP Gateway
- [ ] Given a valid API key, when an agent calls `code.search`, then it receives search results from GitNexus within 2 seconds
- [ ] Given an invalid API key, when any tool is called, then it returns 401 with a clear error message
- [ ] Given a tool call, when it completes, then a structured log entry is written with: tool name, latency, status, agent ID, timestamp

### Code Intelligence
- [ ] Given an indexed repo, when `code.search({query: "user authentication"})` is called, then it returns ranked results with file paths and line numbers
- [ ] Given a symbol name, when `code.context({name: "validateUser"})` is called, then it returns all callers, callees, and process participation
- [ ] Given a target symbol, when `code.impact({target: "parseConfig", direction: "upstream"})` is called, then it returns blast radius with risk level

### Agent Memory
- [ ] Given a completed session, when `memory.store({content: "...", agent: "antigravity"})` is called, then the memory is persisted to mem0
- [ ] Given stored memories, when `memory.search({query: "database migration approach"})` is called, then it returns semantically similar memories ranked by relevance
- [ ] Given per-agent isolation, when agent A stores memory, then agent B cannot read it unless it's in a shared space

### Dashboard
- [ ] Given a new user, when they click "Sign in with GitHub", then they are authenticated and see the overview screen within 5 seconds
- [ ] Given the overview screen, when it loads, then it shows health status for all backend services (green/yellow/red)
- [ ] Given the API keys screen, when an admin creates a key with agent name and permissions, then the key is active and usable immediately
- [ ] Given the logs screen, when new tool calls occur, then log entries appear in real-time without page refresh

## Business Rules

1. **API Key Authentication:** Every MCP tool call MUST include a valid API key. No anonymous access.
2. **Usage Tracking:** Every tool call MUST be logged with: timestamp, agent ID, tool name, latency (ms), HTTP status, request size.
3. **Memory Isolation:** Agent memories are private by default. Shared spaces require explicit opt-in.
4. **Knowledge Curation:** Auto-contributed knowledge enters a "pending" state. Admin must approve before it's indexed.
5. **Quality Scoring:** Quality score = Build (25) + Regression (25) + Standards (25) + Traceability (25) = 100 max.
6. **Handoff Expiry:** Unclaimed handoffs expire after 7 days and are archived.
7. **Rate Limiting:** API keys have configurable rate limits. Default: 1000 requests/hour.

## Out of Scope (v1)

- Multi-user authentication (v1 is single-admin)
- Plugin marketplace for community skills
- Mobile-responsive PWA dashboard
- Agent performance leaderboard
- Slack/Discord alert integrations
- Interactive knowledge graph visualization
- AI-powered code review on pull requests

## Open Questions

1. ~~Server specs~~ — Will be resolved when VPN access is established
2. **Custom domain** — cortex.jackle.dev? hub.jackle.dev? (Depends on available domains)
3. **GitHub App vs OAuth App** — GitHub App provides finer permissions but more setup complexity

## Research Notes

### Competitive Landscape
No direct competitor exists for self-hosted, multi-agent MCP orchestration. Related tools:
- **Composio** — cloud-based agent tooling, not self-hosted
- **LangChain Hub** — prompt/chain sharing, not MCP-native
- **Paperclip** — multi-agent orchestration, not self-hosted intelligence sharing
- **Forgewright** — quality framework (integrated), not a hosting platform

### Technical References
- MCP Specification: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- Cloudflare Workers MCP: built-in MCP server support in Cloudflare Workers
- GitNexus: knowledge graph indexer for code intelligence
- mem0: open-source agent memory with vector + graph backends

## Success Metrics (AARRR)

| Stage | Metric | Target (3-month) |
|-------|--------|-------------------|
| **Activation** | Time from install to first agent connection | < 15 minutes |
| **Activation** | Onboarding completion rate | > 80% |
| **Retention** | Daily active agents | ≥ 2 agents daily |
| **Retention** | Tool calls per day | > 100 |
| **Revenue** | Infrastructure cost | < $1/month |
| **Referral** | GitHub stars | 50+ |
