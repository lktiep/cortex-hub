# Requirements Register — Cortex Hub

> Source: Existing documentation (`README.md`, `project-profile.json`, `tech-stack.md`, `hub-mcp-reference.md`, `database-schema.md`, `ai-policies.md`, user feedback captured during onboarding)

| ID | Requirement | Who | What | Why | Where | When | Which | How | Score | Source | Status |
|----|-------------|-----|------|-----|-------|------|-------|-----|-------|--------|--------|
| R001 | Unified MCP Gateway | ✅ AI agents (Antigravity, GoClaw, any MCP client) | ✅ Single endpoint proxying code.*, memory.*, knowledge.*, quality.*, session.* tools | ✅ Eliminate per-agent config; share intelligence | ✅ Cloudflare Worker (edge) | ✅ Always available (serverless) | ✅ Hub MCP Server app | ✅ Hono routes + auth middleware + tool router | 7/7 | README, project-profile | Ready |
| R002 | Code Intelligence Integration | ✅ All connected agents | ✅ Semantic code search, symbol context, impact analysis, execution flow tracing | ✅ Deep codebase understanding without manual grep | ✅ GitNexus service (Docker) | ✅ On every code query | ✅ GitNexus over MCP tools | ✅ GitNexus indexes repos → Cortex proxies via code.* tools | 7/7 | README, tech-stack | Ready |
| R003 | Persistent Agent Memory | ✅ Per-agent + shared spaces | ✅ Cross-session memory with semantic recall, graph relationships | ✅ Agents remember decisions, avoid repeat work | ✅ mem0 + Neo4j (Docker) | ✅ Every session | ✅ mem0 with Neo4j graph backend | ✅ memory.* tools → mem0 API → Qdrant + Neo4j | 7/7 | README, tech-stack | Ready |
| R004 | Shared Knowledge Base | ✅ All agents + human curators | ✅ Auto-contribution + human curation, semantic search, domain tagging | ✅ Reusable patterns across projects | ✅ Qdrant (Docker) | ✅ Continuous | ✅ knowledge.* tools with weekly review | ✅ knowledge.* tools → Qdrant vector search | 7/7 | README, tech-stack | Ready |
| R005 | Quality Gates | ✅ All agents after work sessions | ✅ 4-dimension scoring (Build+Regression+Standards+Traceability), grade A-F, trend tracking | ✅ Prevent quality degradation | ✅ Dashboard API (SQLite) | ✅ After every session | ✅ quality.* tools + policy enforcement | ✅ Forgewright-inspired quality framework | 7/7 | README, ai-policies | Ready |
| R006 | Session Handoff | ✅ Cross-agent | ✅ Structured context transfer, priority queue, agent-specific or open claims | ✅ Zero context loss between agents | ✅ Dashboard API (SQLite) | ✅ On agent switch | ✅ session.* tools with 7-day expiry | ✅ session.* tools → SQLite | 7/7 | README | Ready |
| R007 | OAuth Quick-Start Onboarding | ✅ New users | ✅ Login via GitHub/OpenAI OAuth → immediate setup, zero-friction entry | ✅ Minimize time-to-value | ✅ Dashboard web (Next.js) | ✅ First visit | ✅ OAuth with OpenAI key auto-import | ✅ OAuth2 flow → session → auto-config | 7/7 | User feedback | Ready |
| R008 | GitHub Repo Import | ✅ Authenticated users | ✅ Web UI to import public/private repos (own, team, external) for indexing | ✅ Enable code intelligence on user repos | ✅ Dashboard web | ✅ After onboarding | ✅ GitHub API + GitNexus indexing | ✅ GitHub OAuth scopes → clone → GitNexus index | 7/7 | User feedback | Ready |
| R009 | MCP API Key Management | ✅ Admins + team leads | ✅ Create/revoke API keys per agent/teammate, usage tracking, fine-grained permissions | ✅ Secure, auditable access control | ✅ Dashboard web + API | ✅ On demand | ✅ Per-key permissions + usage dashboard | ✅ API key CRUD → middleware validation → usage logging | 7/7 | User feedback | Ready |
| R010 | Real-Time Logging | ✅ Dashboard users | ✅ WebSocket-based real-time log streaming, filterable by agent/tool/project/time | ✅ Observability + debugging | ✅ Dashboard web + API | ✅ Always streaming | ✅ WebSocket + analytics charts | ✅ Tool calls → structured logs → WebSocket broadcast → Recharts | 7/7 | User feedback | Ready |
| R011 | Dashboard Web Application | ✅ Admin users | ✅ Overview, Services, Knowledge, Memory, Code Intel, Quality, Sessions screens | ✅ Central management UI | ✅ Next.js 15 → Cloudflare Pages | ✅ Always available | ✅ Full admin dashboard | ✅ Next.js App Router + Hono API backend | 7/7 | README, task.md | Ready |
| R012 | Docker Backend Stack | ✅ Ops/self-hosted | ✅ Docker Compose with Qdrant, Neo4j, mem0, GitNexus + health checks | ✅ One-command backend deployment | ✅ Self-hosted server | ✅ Initial setup | ✅ Docker Compose + Watchtower | ✅ docker compose up -d + health endpoints | 7/7 | README, tech-stack | Ready |
| R013 | Cloudflare Tunnel | ✅ Server admin | ✅ Secure server exposure without open ports | ✅ Zero-trust access, no VPN needed for agents | ✅ Cloudflare Tunnel (free) | ✅ Always on | ✅ cloudflared tunnel | ✅ cloudflared daemon → CNAME to CF | 7/7 | README, tech-stack | Ready |

## Summary

- **Total requirements:** 13
- **Ready (≥ 6/7):** 13
- **Incomplete:** 0
- **Blocked:** 0
- **Average score:** 7.0/7
- **Source coverage:** All requirements validated against existing documentation and user feedback
