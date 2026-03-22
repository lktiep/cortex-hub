<p align="center">
  <img src="docs/assets/logo-placeholder.svg" alt="Cortex Hub" width="120" />
</p>

<h1 align="center">Cortex Hub</h1>

<p align="center">
  <strong>The Neural Intelligence Platform for AI Agent Orchestration</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#documentation">Documentation</a> •
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node" />
  <img src="https://img.shields.io/badge/pnpm-9.x-orange.svg" alt="pnpm" />
  <img src="https://img.shields.io/badge/docker-24%2B-blue.svg" alt="Docker" />
  <img src="https://img.shields.io/badge/status-in%20development-yellow.svg" alt="Status" />
</p>

---

## What is Cortex Hub?

**Cortex** is a self-hosted platform that connects multiple AI coding agents through a unified **MCP (Model Context Protocol)** interface. It provides shared code intelligence, persistent memory, a collaborative knowledge base, quality enforcement, and cross-agent session continuity.

Think of it as **the brain that connects all your AI assistants** — they share knowledge, remember decisions, understand your codebase at a deep level, and hand off work to each other seamlessly.

### Key Capabilities

| Capability | Description |
|---|---|
| 🧠 **Code Intelligence** | AST-aware search, symbol context, impact analysis across all your repos |
| 💾 **Persistent Memory** | Agents remember decisions and context across sessions |
| 📚 **Shared Knowledge** | Agents contribute and consume a shared, searchable knowledge base |
| 🛡️ **Quality Gates** | Automated scoring and enforcement after every work session |
| 🔄 **Session Handoff** | One agent picks up where another left off — zero context loss |
| 🔌 **Universal MCP** | Single endpoint for any MCP-compatible client |

---

## Architecture

```
                    ┌──────────────────────────┐
                    │      AI Agents           │
                    │  ┌─────┐ ┌─────┐ ┌─────┐ │
                    │  │ AG  │ │ GC  │ │ N   │ │
                    │  └──┬──┘ └──┬──┘ └──┬──┘ │
                    └─────┼───────┼───────┼────┘
                          │       │       │
                          ▼       ▼       ▼
               ┌──────────────────────────────────┐
               │   Hub MCP Server                  │
               │   Cloudflare Worker               │
               │                                   │
               │   🔐 Auth  →  🔀 Router           │
               │   📋 Logger → 🛡️ Policy           │
               │                                   │
               │   code.*  memory.*  knowledge.*   │
               │   quality.*  session.*            │
               └──────────┬───────────────────────┘
                          │
            ┌─────────────┼──────────────┐
            ▼             ▼              ▼
     ┌────────────┐ ┌──────────┐  ┌──────────────┐
     │  GitNexus  │ │  Qdrant  │  │  LLM Gateway │
     │  Code      │ │  Vectors │  │  Proxy       │
     │  Graph     │ │  (mem9)  │  │  Multi-LLM   │
     └────────────┘ └──────────┘  └──────────────┘
            │                            │
     ┌──────┴──────┐          ┌──────────┴──────────┐
     │  All Repos  │          │ Gemini │ OpenAI │ …  │
     │  Indexed    │          │ Budget │ Usage  │    │
     └─────────────┘          └─────────────────────┘
```

> **Full architecture docs:** [`docs/architecture/overview.md`](docs/architecture/overview.md)

---

## Features

### 🧠 Code Intelligence (via GitNexus + mem9)

- **Semantic code search** — natural language queries against your entire codebase
- **360° symbol context** — every caller, callee, import, and process for any symbol
- **Blast radius analysis** — see exactly what breaks before you change anything
- **Execution flow tracing** — follow code paths across files and modules
- **Multi-repo support** — all repositories indexed in a single knowledge graph
- **mem9 embedding pipeline** — auto-indexes repos into Qdrant with smart chunking

### 🔀 LLM API Gateway

- **Centralized proxy** — all LLM/embedding calls route through a single gateway
- **Multi-provider support** — Gemini, OpenAI, Anthropic, or any OpenAI-compatible API
- **Fallback chains** — ordered provider slots with automatic retry (429/502/503/504)
- **Format translation** — Gemini ↔ OpenAI format handled transparently
- **Budget enforcement** — daily/monthly token limits from Dashboard settings
- **Usage logging** — every call recorded with exact token counts per agent/model
- **OpenAI-compatible API** — `/v1/embeddings` + `/v1/chat/completions`

> Full docs: [`docs/architecture/llm-gateway.md`](docs/architecture/llm-gateway.md)

### 💾 Agent Memory

- **Cross-session memory** — agents remember past decisions, patterns, and context
- **Semantic recall** — search memories by meaning, not just keywords
- **Per-agent isolation** — each agent has private memory with optional shared spaces

### 📚 Knowledge Base (via Qdrant)

- **Auto-contribution** — agents contribute discovered patterns during work
- **Human curation** — weekly review cycle for quality control
- **Cross-project sharing** — "how to deploy to Cloudflare" is useful everywhere
- **Domain tagging** — organized by technology domain and project

### 🛡️ Quality Gates

- **4-dimension scoring** — Build (25) + Regression (25) + Standards (25) + Traceability (25)
- **Grade system** — A through F, with configurable thresholds
- **Trend tracking** — see quality score over time per project
- **Auto-generated hooks** — Lefthook pre-commit/pre-push from project-profile.json

### 🔄 Session Handoff

- **Structured context** — files changed, decisions made, blockers encountered
- **Priority queue** — pick up the most important pending work first
- **Agent-specific or open** — target a specific agent or let anyone claim it
- **Auto-expiry** — handoffs expire after 7 days to prevent stale work

### 📊 Dashboard

- **Real-time monitoring** — service health, query logs, active sessions
- **LLM Provider management** — add/test/configure providers with smart model discovery
- **Usage analytics** — token consumption by model, agent, day/week/month
- **Budget controls** — set daily/monthly limits with alert thresholds
- **Project management** — repo indexing, embedding status, knowledge base

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **MCP Gateway** | Cloudflare Workers | Hub MCP Server (edge-deployed) |
| **LLM Gateway** | Hono (dashboard-api) | Multi-provider LLM proxy with fallback |
| **Code Intel** | GitNexus + mem9 | AST parsing + embedding pipeline |
| **Vectors** | Qdrant | Semantic search engine |
| **App DB** | SQLite (WAL) | Usage logs, budgets, providers, sessions |
| **API** | Hono | Dashboard backend |
| **Frontend** | Next.js 15 + React 19 | Dashboard web interface |
| **Infra** | Docker Compose | Service orchestration |
| **Tunnel** | Cloudflare Tunnel | Secure exposure, zero open ports |
| **CI/CD** | Lefthook + GitHub Actions | Git hooks + automated testing |
| **Monorepo** | pnpm + Turborepo | Build orchestration |

> **Full stack details:** [`docs/architecture/tech-stack.md`](docs/architecture/tech-stack.md)

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
1. **Administrator** — Full Docker stack, infrastructure, and onboarding
2. **Member** — Connect your local agent to an existing Hub (prompts for MCP URL + API key)

### Manual Setup

```bash
# 1. Clone
git clone https://github.com/<org>/cortex-hub.git
cd cortex-hub

# 2. Install dependencies
corepack enable
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your API keys

# 4. Start backend services
cd infra && docker compose up -d

# 5. Build and start
pnpm -r build
pnpm dev
```

### Verify Installation

```bash
# All services healthy?
curl http://localhost:4000/health     # Dashboard API
curl http://localhost:6333/healthz    # Qdrant
curl http://localhost:4848/health     # GitNexus
```

> **Full installation guide:** [`docs/guides/installation.md`](docs/guides/installation.md)

---

## Installation

### Development (Local)

```bash
git clone https://github.com/<org>/cortex-hub.git
cd cortex-hub
pnpm install
pnpm dev
```

### Production (Self-Hosted Server)

See the complete [Implementation Guide](docs/guides/implementation.md) for:
1. Server provisioning and Docker setup
2. Cloudflare Tunnel configuration
3. Service deployment and health checks
4. Agent connection configuration

### Docker-Only (Planned)

```bash
docker run -d \
  --name cortex \
  -p 3000:3000 -p 4000:4000 \
  -v cortex-data:/data \
  -e OPENAI_API_KEY=sk-... \
  cortexhub/cortex:latest
```

### Package Manager (Planned)

```bash
# npm
npx cortex-hub@latest init

# Homebrew
brew install cortex-hub
```

---

## Project Structure

```
cortex-hub/
├── packages/                    # Shared libraries
│   ├── shared-types/            #   TypeScript type definitions
│   ├── shared-utils/            #   Common utility functions
│   ├── shared-mem9/             #   Embedding pipeline + vector store
│   └── ui-components/           #   Shared React components
├── apps/
│   ├── hub-mcp/                 # Hub MCP Server (Cloudflare Worker)
│   ├── dashboard-api/           # Dashboard Backend (Hono + SQLite)
│   │   └── routes/llm.ts        #   ← LLM Gateway (multi-provider proxy)
│   └── dashboard-web/           # Dashboard Frontend (Next.js 15)
├── infra/                       # Docker Compose + scripts
├── scripts/                     # Bootstrap + onboarding scripts
├── docs/                        # Documentation
└── .cortex/                     # Project profile + code conventions
```

> **Full structure breakdown:** [`docs/architecture/monorepo-structure.md`](docs/architecture/monorepo-structure.md)

---

## Documentation

| Document | Description |
|---|---|
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | System architecture and component diagram |
| [`docs/architecture/llm-gateway.md`](docs/architecture/llm-gateway.md) | LLM Gateway: fallback chains, budget, usage logging |
| [`docs/architecture/monorepo-structure.md`](docs/architecture/monorepo-structure.md) | Detailed directory layout and package graph |
| [`docs/architecture/tech-stack.md`](docs/architecture/tech-stack.md) | Technology choices with versions and licenses |
| [`docs/architecture/agent-quality-strategy.md`](docs/architecture/agent-quality-strategy.md) | Quality gates and scoring dimensions |
| [`docs/database/erd.md`](docs/database/erd.md) | Database ERD and schema definitions |
| [`.cortex/code-conventions.md`](.cortex/code-conventions.md) | Code conventions and standards |

---

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| **Phase 1** | Server + Cloudflare Tunnel | ✅ Done |
| **Phase 2** | Monorepo skeleton + shared packages | ✅ Done |
| **Phase 3** | Docker stack (Qdrant, CLIProxy, Watchtower) | ✅ Done |
| **Phase 4** | Hub MCP Server (Cloudflare Worker) | ✅ Done |
| **Phase 5** | Dashboard Frontend (Next.js 15) | ✅ Done |
| **Phase 6** | Polish, docs, testing, GA release | 🔄 In Progress |

### Recent Milestones

- [x] LLM API Gateway with multi-provider fallback + budget enforcement
- [x] mem9 embedding pipeline (repo → Qdrant)
- [x] Smart provider model discovery (no hardcoded lists)
- [x] Interactive onboarding script (`bootstrap.sh`)
- [x] Lefthook git hooks auto-generated from project profile
- [x] Usage analytics dashboard

### Planned Features

- [ ] Streaming chat completions via gateway
- [ ] Agent performance leaderboard
- [ ] Interactive knowledge graph visualization
- [ ] Slack/Discord alert integrations
- [ ] Plugin marketplace for community skills

---

## Cost

Cortex is designed to run almost entirely on free tiers:

| Component | Cost |
|---|---|
| Self-hosted server | Your existing infrastructure |
| Cloudflare Workers | Free (100K req/day) |
| Cloudflare Tunnel | Free |
| LLM API (via gateway) | Depends on provider — budget-controlled |
| **Total** | **≈ $0 + LLM usage** |

---

## Contributing

We welcome contributions! See our [Contributing Guide](docs/CONTRIBUTING.md) for:
- Development setup
- Branch strategy and commit conventions
- Code standards and review process
- Knowledge contribution guidelines

---

## License

MIT © Cortex Hub Contributors
