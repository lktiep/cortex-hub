<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-placeholder.svg">
    <img src="docs/assets/logo-placeholder.svg" alt="Cortex Hub" width="100" />
  </picture>
</p>

<h1 align="center">Cortex Hub</h1>

<p align="center">
  <strong>Self-hosted AI Agent Intelligence Platform</strong><br/>
  <em>Unified MCP gateway · Persistent memory · Code intelligence · Quality enforcement</em>
</p>

<p align="center">
  <a href="#why-cortex">Why Cortex</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#mcp-tools">MCP Tools</a> ·
  <a href="#docs">Docs</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/MCP-compliant-8A2BE2?style=flat-square" alt="MCP" />
  <img src="https://img.shields.io/badge/node-%E2%89%A522-43853d?style=flat-square&logo=node.js&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/pnpm-9.x-F69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm" />
  <img src="https://img.shields.io/badge/docker-24%2B-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/phase_6-GA_polish-blue?style=flat-square" alt="Phase" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

---

## Why Cortex?

Every AI coding agent today works in **isolation** — no shared memory, no knowledge transfer, no quality tracking. When you switch between Claude Code, Cursor, Gemini, or a headless bot, each starts from zero.

**Cortex Hub** solves this by providing a single self-hosted backend that **all your agents connect to** via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/):

```
                    You
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   Claude Code    Cursor     Antigravity
        │            │            │
        └────────────┼────────────┘
                     │
              ┌──────▼──────┐
              │  Cortex Hub │  ← single MCP endpoint
              │             │
              │  Memory     │  Agents remember across sessions
              │  Knowledge  │  Shared, searchable knowledge base
              │  Code Intel │  AST-aware search + impact analysis
              │  Quality    │  Build/typecheck/lint enforcement
              │  Sessions   │  Cross-agent task handoff
              └─────────────┘
```

> **Zero data leaves your infrastructure.** Every component runs on your own server behind a Cloudflare Tunnel.

---

## Architecture

```mermaid
graph TB
    subgraph Agents["AI Agents (any MCP client)"]
        AG["🤖 Antigravity<br/>(Gemini)"]
        CC["🐙 Claude Code"]
        CU["⚡ Cursor"]
        BOT["🤖 Headless Bots"]
    end

    subgraph Gateway["Hub MCP Server"]
        AUTH["🔐 API Key Auth"]
        ROUTER["🔀 Tool Router"]
        TEL["📊 Telemetry Logger"]
    end

    subgraph Services["Backend Services (Docker)"]
        direction LR
        GN["GitNexus<br/>AST Graph :4848"]
        M9["mem9<br/>Memory :4000"]
        QD["Qdrant<br/>Vectors :6333"]
        DB["SQLite<br/>WAL Mode"]
    end

    subgraph LLM["LLM Gateway"]
        PROXY["Multi-Provider Proxy"]
        GEM["Gemini"]
        OAI["OpenAI"]
        ANT["Anthropic"]
    end

    subgraph Frontend["Dashboard"]
        DASH["Next.js 15<br/>React 19"]
    end

    Agents --> AUTH --> ROUTER --> TEL
    TEL --> Services
    ROUTER -->|"code_search<br/>code_impact"| GN
    ROUTER -->|"memory_search<br/>memory_store"| M9
    ROUTER -->|"knowledge_search<br/>knowledge_store"| QD
    ROUTER -->|"quality_report<br/>session_start"| DB
    PROXY --> GEM & OAI & ANT
    DASH --> DB
    M9 --> QD
```

### Network Topology

```
Internet
  │
  ├── cortex-mcp.jackle.dev ──── Hub MCP Server (Hono, SSE + JSON-RPC)
  ├── cortex-api.jackle.dev ──── Dashboard API  (Hono + SQLite)
  └── hub.jackle.dev ─────────── Dashboard UI   (Next.js static export)
                                    │
                              Cloudflare Tunnel
                                    │
                          ┌─────────┼─────────┐
                          │  Docker Compose    │
                          │  ├─ dashboard-api  │
                          │  ├─ hub-mcp        │
                          │  ├─ qdrant         │
                          │  ├─ gitnexus       │
                          │  ├─ llm-proxy      │  ← internal only
                          │  └─ watchtower     │
                          └────────────────────┘
                          All ports internal.
                          Zero open ports on host.
```

---

## Features

### 🧠 Code Intelligence — GitNexus + mem9

| Capability | How It Works |
|---|---|
| **Semantic code search** | Natural language → AST-aware results across all repos |
| **360° symbol context** | Every caller, callee, import chain for any function/class |
| **Blast radius analysis** | See downstream impact before editing (`cortex_code_impact`) |
| **Execution flow tracing** | Follow code paths across files and modules |
| **Multi-repo indexing** | All repositories in a single knowledge graph |
| **Auto-embedding** | mem9 indexes repos into Qdrant with smart chunking |

### 💾 Persistent Agent Memory

Agents **remember** across sessions and conversations.

```
Session 1 (Claude Code):  "The auth middleware uses JWT with RS256"
                                    ↓ cortex_memory_store
Session 2 (Cursor):        cortex_memory_search("auth middleware") 
                                    → "JWT with RS256" ✓
```

- Per-agent isolation with optional shared spaces
- Semantic recall (search by meaning, not keywords)
- Automatic deduplication and relevance ranking

### 📚 Shared Knowledge Base — Qdrant

Agents contribute and consume a team-wide knowledge base:

- **Auto-contribution** — agents store bug fixes, patterns, and decisions during work
- **Semantic search** — find relevant knowledge by concept, not exact match
- **Tag & project filtering** — organized by domain and repository
- **Cross-project sharing** — deployment patterns, API conventions, etc.

### 🔀 LLM API Gateway

Centralized proxy for all LLM/embedding calls:

- **Multi-provider** — Gemini, OpenAI, Anthropic, or any OpenAI-compatible API
- **Ordered fallback chains** — automatic retry on 429 / 502 / 503 / 504
- **Gemini ↔ OpenAI format translation** — handled transparently
- **Budget enforcement** — daily/monthly token limits from Dashboard
- **Usage logging** — exact token counts per agent, model, and day
- **OpenAI-compatible** — `/v1/embeddings` + `/v1/chat/completions`

### 🛡️ Quality Gates

4-dimension scoring after every work session:

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| Build | 25 | Code compiles without errors |
| Regression | 25 | No existing tests broken |
| Standards | 25 | Follows code-conventions.md |
| Traceability | 25 | Changes linked to requirements |

Grades A→F with trend tracking. Auto-generated git hooks via `project-profile.json`.

### 🔄 Session Handoff

One agent picks up where another left off:

- **Structured context** — files changed, decisions made, blockers
- **API key tracking** — see which key initiated each session
- **Priority queue** — pick up the most important work first
- **Auto-expiry** — stale handoffs expire after 7 days

### 📊 Dashboard

Real-time monitoring and management:

- Service health (Qdrant, GitNexus, mem9, MCP)
- Query analytics per project (total queries, active agents)
- LLM usage — token consumption by model, agent, day/week/month
- Provider management — add/test/configure with smart model discovery
- Project management — repo indexing, embedding status
- Quality reports with grade trends

---

## MCP Tools

Cortex exposes **12 tools** via a single MCP endpoint. Any MCP-compatible client can use them:

| # | Tool | Purpose |
|---|------|---------|
| 1 | `cortex_session_start` | Start a development session, get project context |
| 2 | `cortex_session_end` | Close session, persist summary |
| 3 | `cortex_changes` | Check for unseen code changes from other agents |
| 4 | `cortex_code_search` | AST-aware semantic code search (GitNexus) |
| 5 | `cortex_code_impact` | Blast radius analysis before editing |
| 6 | `cortex_code_reindex` | Trigger re-indexing after code changes |
| 7 | `cortex_memory_search` | Recall agent memories by semantic similarity |
| 8 | `cortex_memory_store` | Store findings for future recall |
| 9 | `cortex_knowledge_search` | Search shared knowledge base |
| 10 | `cortex_knowledge_store` | Contribute bug fixes, patterns, decisions |
| 11 | `cortex_quality_report` | Report build/typecheck/lint results |
| 12 | `cortex_health` | Check all backend service health |

> **Full API reference:** [`docs/api/hub-mcp-reference.md`](docs/api/hub-mcp-reference.md)

---

## Quick Start

### Prerequisites

- Docker 24+ with Compose v2
- Node.js 22 LTS
- pnpm 9.x
- A Cloudflare account (free tier)

### One-Command Install

```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/bootstrap.sh | bash
```

The bootstrap script offers two modes:

| Mode | Who | What It Does |
|------|-----|-------------|
| **Administrator** | Server owner | Full Docker stack, infra, tunnel setup |
| **Member** | Team dev | Connects local agent to an existing Hub |

### Manual Setup

```bash
# 1. Clone
git clone https://github.com/lktiep/cortex-hub.git
cd cortex-hub

# 2. Install
corepack enable && pnpm install

# 3. Configure
cp .env.example .env
# Edit .env with your API keys (Gemini, OpenAI, etc.)

# 4. Start backend
cd infra && docker compose up -d

# 5. Build & run
pnpm build && pnpm dev
```

### Connect Your Agent (Member Install)

Connect your IDE agent to an existing Cortex Hub — **no need to clone the repo**:

```bash
# One-liner: download and run onboard script from any project directory
bash <(curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/onboard.sh)
```

Or with API key pre-configured:

```bash
HUB_API_KEY=your-key bash <(curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/onboard.sh) --tool antigravity
```

The onboarding script will:
- ✅ Inject MCP config into your IDE (Claude, Cursor, Windsurf, VS Code, Gemini)
- ✅ Generate `.cortex/project-profile.json` with verify commands
- ✅ Install Lefthook git hooks (pre-commit + pre-push)
- ✅ Deploy workflow templates (`.agents/workflows/`)
- ✅ Generate agent rules (`.cortex/agent-rules.md`)

### Verify

```bash
curl https://cortex-api.jackle.dev/health     # Dashboard API
curl https://cortex-mcp.jackle.dev/health     # MCP Server
```

---

## Tech Stack

| Layer | Technology | Role |
|---|---|---|
| **MCP Server** | Hono (Node.js, Docker) | Streamable HTTP + JSON-RPC gateway |
| **Code Intel** | GitNexus | AST parsing, execution flow, impact analysis |
| **Embeddings** | mem9 + Qdrant | Auto-index repos → vector search |
| **LLM Proxy** | Hono | Multi-provider gateway with fallback chains |
| **App DB** | SQLite (WAL) | Sessions, quality, usage, providers, budgets |
| **API** | Hono | Dashboard backend REST API |
| **Frontend** | Next.js 15 + React 19 | Dashboard web interface (static export) |
| **Infra** | Docker Compose | Service orchestration |
| **Tunnel** | Cloudflare Tunnel | Secure exposure, zero open ports |
| **Hooks** | Lefthook | Git hooks from `project-profile.json` |
| **Monorepo** | pnpm + Turborepo | Build orchestration + caching |

---

## Project Structure

```
cortex-hub/
├── apps/
│   ├── hub-mcp/                 # MCP Server (Hono, Streamable HTTP)
│   │   └── src/tools/           #   12 MCP tool implementations
│   ├── dashboard-api/           # Dashboard Backend (Hono + SQLite)
│   │   ├── routes/llm.ts        #   LLM Gateway (multi-provider proxy)
│   │   ├── routes/quality.ts    #   Quality gates + session handoffs
│   │   └── routes/stats.ts      #   Analytics + telemetry ingestion
│   └── dashboard-web/           # Dashboard Frontend (Next.js 15)
│       └── src/app/             #   12 pages: dashboard, sessions, quality, ...
├── packages/
│   ├── shared-types/            # TypeScript type definitions
│   ├── shared-utils/            # Logger, error classes, common utilities
│   └── shared-mem9/             # Embedding pipeline + vector store client
├── infra/
│   └── docker-compose.yml       # Qdrant, GitNexus, Watchtower
├── scripts/
│   ├── bootstrap.sh             # One-command install (admin + member modes)
│   └── onboard.sh               # Universal agent onboarding (6 IDE tools)
├── templates/
│   └── workflows/               # Portable workflow templates for any project
├── docs/                        # Architecture, API reference, guides
├── .cortex/                     # Project profile + code conventions
└── .agents/workflows/           # Active workflow definitions (/code, /continue, /phase)
```

---

## Docs

| Document | Description |
|---|---|
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | System architecture with Mermaid diagrams |
| [`docs/architecture/llm-gateway.md`](docs/architecture/llm-gateway.md) | LLM Gateway: fallback chains, budget, usage |
| [`docs/architecture/monorepo-structure.md`](docs/architecture/monorepo-structure.md) | Package graph and dependency flow |
| [`docs/architecture/agent-quality-strategy.md`](docs/architecture/agent-quality-strategy.md) | Quality gates, scoring, and enforcement |
| [`docs/api/hub-mcp-reference.md`](docs/api/hub-mcp-reference.md) | Full MCP tool API reference |
| [`docs/api/database-schema.md`](docs/api/database-schema.md) | Database schema reference |
| [`docs/database/erd.md`](docs/database/erd.md) | Entity-relationship diagram |
| [`docs/guides/installation.md`](docs/guides/installation.md) | Full installation guide |
| [`docs/guides/onboarding.md`](docs/guides/onboarding.md) | Agent onboarding walkthrough |
| [`.cortex/code-conventions.md`](.cortex/code-conventions.md) | Code conventions and standards |

---

## Roadmap

| Phase | What Was Built | Status |
|---|---|---|
| **Phase 1** | Ubuntu server provisioning, Docker 24+, Cloudflare Tunnel (`cloudflared`) | ✅ |
| **Phase 2** | pnpm + Turborepo monorepo, `shared-types`, `shared-utils`, `shared-mem9` packages | ✅ |
| **Phase 3** | Docker Compose stack: Qdrant, GitNexus eval-server, LLM Proxy, Watchtower | ✅ |
| **Phase 4** | Hub MCP Server: 12 tools, Streamable HTTP, API key auth, telemetry logging | ✅ |
| **Phase 5** | Dashboard: 12 pages, LLM Gateway, quality reports, sessions, usage analytics | ✅ |
| **Phase 6** | Polish, documentation, testing, GA release | 🔄 |

### What's Built (Highlights)

**Infrastructure**
- ✅ 2-service Docker architecture: `cortex-api` (:4000) + `cortex-mcp` (:8317)
- ✅ Cloudflare Tunnel: 4 subdomains, zero open ports
- ✅ Watchtower auto-updates for Docker images
- ✅ Docker build optimization: cache mounts, shared base, `.dockerignore`

**MCP Server (12 tools)**
- ✅ Streamable HTTP transport (JSON-RPC over POST, SSE for streaming)
- ✅ API key auth with `X-API-Key-Owner` identity resolution
- ✅ Global telemetry: every tool call logged with agent, latency, project
- ✅ Code intelligence: `code_search`, `code_impact`, `code_reindex` (GitNexus)
- ✅ Agent memory: `memory_search`, `memory_store` (mem9 → Qdrant)
- ✅ Knowledge base: `knowledge_search`, `knowledge_store` (Qdrant)
- ✅ Sessions: `session_start`, `session_end`, `changes`, `health`
- ✅ Quality: `quality_report` with 4D scoring (Build/Regression/Standards/Traceability)

**Dashboard (12 pages)**
- ✅ Hero stats bar + per-project overview cards
- ✅ LLM provider management: add/test/configure, smart model discovery
- ✅ Usage analytics: token consumption by model, agent, time period
- ✅ Budget controls: daily/monthly limits with alert thresholds
- ✅ Quality reports with grade trending (A→F)
- ✅ Session list with API key tracking + detail panel
- ✅ Project management with Git integration + branch-aware indexing
- ✅ Mobile-responsive: hamburger sidebar, 3-tier CSS breakpoints

**LLM API Gateway**
- ✅ Multi-provider: Gemini, OpenAI, Anthropic, any OpenAI-compatible
- ✅ Ordered fallback chains with auto-retry (429/502/503/504)
- ✅ Gemini ↔ OpenAI format translation
- ✅ Budget enforcement with daily/monthly token limits
- ✅ Usage logging per agent, model, day

**Developer Experience**
- ✅ Universal onboarding: supports Claude Code, Cursor, Windsurf, VS Code, Gemini, headless bots
- ✅ Remote install: `bash <(curl ...)` — no clone needed
- ✅ Lefthook git hooks auto-generated from `project-profile.json`
- ✅ Workflow templates deployed to any project (code, continue, phase)
- ✅ Agent-facing rules auto-generated (`.cortex/agent-rules.md`)

### Planned

- [ ] Streaming chat completions via LLM gateway
- [ ] Agent performance leaderboard
- [ ] Interactive knowledge graph visualization
- [ ] Slack/Discord notification integrations
- [ ] Cloudflare Access for Dashboard UI protection

---

## Cost

Cortex runs on **near-zero** infrastructure cost — everything is self-hosted:

| Component | Cost | Notes |
|---|---|---|
| Linux server | Your existing hardware or VPS | Any machine with Docker |
| Cloudflare Tunnel | Free | Secure exposure, no open ports |
| Qdrant | Free | Self-hosted in Docker |
| GitNexus | Free | Self-hosted code intelligence |
| mem9 | Free | Self-hosted embedding pipeline |
| Dashboard | Free | Next.js static export, served by API |
| LLM API calls | Pay-per-use | Your own keys, budget-controlled |
| **Total** | **$0 + LLM token usage** | |

---

## Contributing

See the [Contributing Guide](docs/CONTRIBUTING.md) for development setup, commit conventions, and code standards.

## License

MIT © Cortex Hub Contributors

