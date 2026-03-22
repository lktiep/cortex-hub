# Technology Stack

> Every component in Cortex is open source, self-hosted, and vendor-lock-in free.

---

## Core Stack

| Layer | Technology | Version | License | Role |
|---|---|---|---|---|
| **Runtime** | Node.js | 22 LTS | MIT | Server runtime |
| **Language** | TypeScript | 5.x | Apache 2.0 | Type safety across all packages |
| **Package Manager** | pnpm | 9.x | MIT | Fast, disk-efficient monorepo |
| **Build System** | Turborepo | 2.x | MIT | Monorepo task orchestration |

## Backend Services

| Service | Technology | Version | License | Role |
|---|---|---|---|---|
| **Code Intelligence** | GitNexus | latest | MIT | AST parsing, graph analysis, impact detection (Docker eval-server on :4848) |
| **Vector Database** | Qdrant | 1.13+ | Apache 2.0 | Semantic search for knowledge + memory |
| **Agent Memory** | mem9 (in-process) | latest | MIT | Long-term memory with vector embeddings |
| **Application DB** | SQLite (WAL mode) | 3.x | Public Domain | Quality reports, sessions, query logs |
| **API Framework** | Hono | 4.x | MIT | Lightweight, edge-ready HTTP framework |

## Infrastructure

| Component | Technology | Tier | Role |
|---|---|---|---|
| **Edge Gateway** | Cloudflare Workers | Free (100K req/day) | Hub MCP Server hosting |
| **Tunnel** | Cloudflare Tunnel | Free | Secure server exposure, zero open ports |
| **Static Hosting** | Cloudflare Pages | Free | Dashboard frontend deployment |
| **Containers** | Docker + Compose | Free | Service orchestration |
| **Auto-update** | Watchtower | Free | Container image auto-updates |
| **CI/CD** | GitHub Actions | Free (public) | Lint, test, build, deploy |

## Frontend

| Technology | Version | License | Role |
|---|---|---|---|
| **Framework** | Next.js | 15.x | MIT | React framework with App Router |
| **UI Library** | React | 19.x | MIT | Component rendering |
| **Styling** | Vanilla CSS + CSS Variables | — | Design system tokens |
| **Font** | Inter (Google Fonts) | OFL | Modern, clean typography |
| **Charts** | Recharts | 2.x | MIT | Data visualization |
| **WebSocket** | Native WebSocket API | — | Real-time dashboard updates |

---

## Estimated Monthly Cost

| Item | Cost |
|---|---|
| Server (self-hosted / existing VPS) | $0 |
| Cloudflare Workers (free tier) | $0 |
| Cloudflare Pages (free tier) | $0 |
| Cloudflare Tunnel | $0 |
| GitHub repository | $0 |
| OpenAI API (mem9 embeddings, gpt-4.1-nano) | ~$0.05 |
| **Total** | **≈ $0.05/month** |
