# Use Cases & Why Cortex Hub

> Real-world scenarios demonstrating the value of centralized AI agent infrastructure.

---

## The Problem: AI Agents Work in Isolation

Today's AI coding agents (Claude Code, Cursor, Gemini, etc.) are powerful individually — but they operate in complete isolation:

- **No memory** — every new conversation starts from zero
- **No shared knowledge** — agent A discovers a bug fix, agent B repeats the same debugging
- **No code intelligence** — agents grep blindly instead of using AST-aware search
- **No quality tracking** — no visibility into what agents produce
- **No coordination** — multiple agents editing the same codebase creates conflicts

**Cortex Hub eliminates all of these.** One self-hosted backend gives every agent persistent memory, shared knowledge, code intelligence, and quality enforcement.

---

## Use Case 1: Cross-Session Memory

### Without Cortex
```
Session 1 (Monday, Claude Code):
  "The auth middleware uses JWT with RS256, and the secret is loaded from Vault..."
  → Agent writes the feature, closes session.

Session 2 (Tuesday, Cursor):
  User: "Update the auth middleware"
  Agent: "I don't see any auth middleware. Can you tell me about your auth setup?"
  → 15 minutes wasted re-explaining context.
```

### With Cortex
```
Session 1 (Monday, Claude Code):
  cortex_memory_store("auth middleware uses JWT RS256, secret from Vault, middleware at src/auth/jwt.ts")

Session 2 (Tuesday, Cursor):
  cortex_memory_search("auth middleware")
  → "JWT RS256, secret from Vault, middleware at src/auth/jwt.ts"
  → Agent immediately knows where and what to edit. 0 time wasted.
```

> **Savings:** 10-15 minutes per context switch × 5+ switches/day = **~1 hour/day**

---

## Use Case 2: Shared Bug Knowledge

### Without Cortex
```
Agent A debugs for 30 minutes: "ESM imports in Docker require .js extension in TypeScript"
  → Fixes it, moves on.

Agent B hits the same issue next week:
  → Spends another 30 minutes debugging the same thing.

Agent C hits it a month later:
  → Another 30 minutes.
```

### With Cortex
```
Agent A: cortex_knowledge_store("ESM imports in Docker require .js extension", tags: ["docker", "typescript"])

Agent B: cortex_knowledge_search("Docker ESM import error")
  → Gets the answer in 2 seconds.
  → Total debugging time: 0.
```

> **Savings:** 30+ minutes per known bug × N agents × recurring issues = **hours/week**

---

## Use Case 3: Code Intelligence vs Blind Grep

### Without Cortex (grep_search)
```
Agent: grep_search("handlePayment")
  → 47 results across 23 files
  → Agent reads through all of them to understand context
  → Output: ~50K tokens consumed, 2 minutes of agent time
```

### With Cortex (cortex_code_search + code_context)
```
Agent: cortex_code_search("payment processing flow")
  → 3 execution flows ranked by relevance
  → Shows: entry point → validation → processing → notification

Agent: cortex_code_context("handlePayment")
  → Callers: PaymentController.process(), SubscriptionService.renew()
  → Callees: validateCard(), chargeStripe(), sendReceipt()
  → Execution flows: "Payment Processing", "Subscription Renewal"

Agent: cortex_code_impact("handlePayment")
  → Risk: HIGH — affects 12 downstream symbols, 3 execution flows
  → Agent knows exactly what to test after editing
```

> **Savings:** 80% fewer tokens (focused results vs grep dump), better accuracy, risk awareness

---

## Use Case 4: Multi-Agent Team Coordination

### Without Cortex
```
Agent A (Antigravity) edits api/routes.ts at 2pm
Agent B (Claude Code) edits api/routes.ts at 3pm
  → Git conflict. Agent B doesn't know Agent A already changed this file.
  → User resolves manually, wastes 20 minutes.
```

### With Cortex
```
Agent B: cortex_session_start(...)
  → "⚠️ 2 unseen changes from agent 'antigravity': api/routes.ts modified 1h ago"
  → Agent B runs `git pull` first, avoids conflict entirely.

Agent B: cortex_changes(agentId: "claude-code", projectId: "proj-xxx")
  → Shows exactly which files were touched by other agents.
```

> **Savings:** Prevents merge conflicts entirely, saves 20+ minutes per incident

---

## Use Case 5: Quality Enforcement Across All Agents

### Without Cortex
```
Agent deploys code that fails typecheck in CI.
  → 10-minute CI pipeline wasted.
  → Developer reviews, triggers fix, waits for CI again.
  → Total: 30 minutes + context switching.
```

### With Cortex
```
Every session ends with:
  cortex_quality_report({
    buildPassed: true,
    typecheckPassed: true,
    lintPassed: true
  })
  → Score: 95/100, Grade: A

Session compliance is tracked:
  → "Discovery: 100%, Safety: 50% (missed code_impact), Learning: 100%"
  → Agent gets hints: "🛡️ Use cortex_code_impact before editing core files"
```

> **Savings:** Catches issues before commit, prevents CI waste, tracks quality trends

---

## Use Case 6: Multi-Member Team on One Project

### Scenario
A 3-person team (Dev A uses Antigravity, Dev B uses Claude Code, Dev C uses Cursor) works on the same e-commerce project. Each developer has their own agent, style, and workflow.

### Without Cortex
```
Dev A's agent discovers: "Payment webhook must use idempotency keys to prevent duplicates"
  → Implements it correctly.

Dev B (new to the project, next week):
  → Agent doesn't know about the idempotency pattern.
  → Implements a second webhook handler WITHOUT idempotency keys.
  → Production bug: duplicate charges.
  
Dev C reviews and finds both implementations:
  → Spends 45 minutes understanding which one is correct.
  → Consolidates, but breaks Dev A's tests.
  → Total waste: 2-3 hours of team time.
```

### With Cortex
```
Dev A's agent: cortex_knowledge_store(
  title: "Payment webhooks require idempotency",
  content: "Always use X-Idempotency-Key header. See src/webhooks/payment.ts for pattern.",
  tags: ["payments", "patterns", "critical"]
)

Dev B's agent (next week):
  cortex_knowledge_search("webhook payment")
  → "Payment webhooks require idempotency. See src/webhooks/payment.ts"
  → Agent follows the established pattern. Zero duplicate effort.

Dev C's agent (reviewing):
  cortex_code_context("handlePaymentWebhook")
  → One implementation, one caller chain, consistent pattern.
  → Review takes 5 minutes instead of 45.
```

> **Savings:** Prevents architectural drift, eliminates duplicate implementations, reduces review time by 80%

---

## Use Case 7: Cross-Project Knowledge Exploration

### Scenario
You manage multiple projects (e.g., an e-commerce platform, a game server, an internal tool). You need to implement a damage calculation system in the game — but a similar formula pattern already exists in the e-commerce project's pricing engine.

### Without Cortex
```
Agent works on GameServer project:
  User: "Implement damage formula: base_atk × skill_multiplier × (1 - defense_rate)"
  Agent: Writes from scratch, guesses at patterns, no context from other projects.
  → 2 hours implementing, testing, and refining.

Later: "We need the same pattern for the pricing engine"
  → Agent starts from zero again in the e-commerce project.
```

### With Cortex
```
Agent: cortex_list_repos()
  → Shows all indexed repos: game-server (proj-abc), e-commerce (proj-def), internal-tool (proj-ghi)

Agent: cortex_code_search(query: "multiplier calculation formula", projectId: "proj-def")
  → Finds PricingEngine.calculateFinalPrice() — uses same pattern:
    base_price × discount_rate × (1 - tax_modifier)

Agent: cortex_code_context(name: "calculateFinalPrice", projectId: "proj-def")
  → Shows full implementation with validation, edge cases, rounding logic
  → Agent adapts the pattern for damage calculation in 15 minutes.

Agent: cortex_knowledge_store(
  title: "Multiplier formula pattern (shared across projects)",
  content: "base × multiplier × (1 - reduction). Used in PricingEngine and DamageCalculator.",
  tags: ["patterns", "math", "cross-project"]
)
  → Future agents on ANY project can find this pattern instantly.
```

> **Savings:** Cross-project knowledge transfer, reuse architectural patterns, ~75% faster implementation for similar features

---

## Cortex Hub vs Standalone Tools

| Aspect | **Standalone Tools** (GitNexus + mem9 local) | **Cortex Hub** |
|--------|----------------------------------------------|----------------|
| **Setup** | Install each tool separately on each dev machine | One `docker compose up`, all agents connect |
| **Memory** | Per-machine only, lost when VM resets | Persistent server-side, survives reboots |
| **Knowledge sharing** | No cross-agent sharing | All agents read/write same knowledge base |
| **Code intelligence** | One repo per GitNexus instance | Multi-repo graph, cross-project search |
| **Agent coordination** | None — agents work blind | Session tracking, change detection, conflict prevention |
| **Quality tracking** | None | 4-dimension scoring, grade trends, compliance enforcement |
| **LLM management** | Each agent has own API keys | Centralized proxy with budget, fallback, usage logging |
| **Team scaling** | Re-setup for every new member | `onboard.sh` / `onboard.ps1` — one command |
| **Admin visibility** | No dashboard, no analytics | Full dashboard: sessions, quality, usage, projects |
| **Token optimization** | Agents grep/dump raw files | AST-aware search returns focused results (~80% fewer tokens) |
| **Time to first value** | Immediate (no server needed) | 30 min setup, then exponentially faster over time |
| **Agent "intelligence"** | Generic — no project context | Contextual — agents recall past decisions, patterns, and bugs |
| **Compound ROI** | Linear — each session starts fresh | Exponential — knowledge compounds over weeks/months |
| **Cross-project insight** | Impossible — tools are project-isolated | Natural — search/explore across all indexed repos |

### When Standalone is Better

- **Single developer, single machine** — if you only use one agent on one project, the overhead of a server is unnecessary
- **Air-gapped/offline** — no network dependency
- **Very small projects** — <1K LOC, code intelligence adds minimal value
- **Quick throwaway prototypes** — embedding cost isn't justified for 1-day projects

### When Cortex Hub Wins

- **Multiple agents** — Claude + Cursor + Gemini working on the same codebase
- **Team collaboration** — 2+ developers sharing agents, avoiding duplicate work
- **Multi-repo projects** — cross-project code search, pattern reuse, impact analysis
- **Long-running projects** — memory accumulation becomes invaluable after 2+ weeks
- **Quality-critical work** — compliance tracking prevents shipping broken code
- **Knowledge-heavy domains** — domains where the same bugs, patterns, and gotchas recur

---

## Tradeoffs & Honest Limitations

Most tools don't talk about their downsides. We do.

### 1. Initial Embedding Cost

Cortex uses LLM embeddings (via mem9 + Qdrant) to index your codebase and enable semantic search. This has a **one-time setup cost**:

| Repo Size | Files | Initial Embedding Cost | Time |
|-----------|-------|----------------------|------|
| Small (< 5K LOC) | ~50 files | ~$0.01-0.03 | < 1 min |
| Medium (10-50K LOC) | ~200 files | ~$0.05-0.15 | 2-5 min |
| Large (100K+ LOC) | ~1000 files | ~$0.30-1.00 | 10-30 min |

**But here's what they don't tell you:** this is a **one-time cost per repo**. After initial indexing:
- Re-indexing on code changes is incremental (pennies)
- Knowledge search uses the same embeddings forever
- The ROI curve is exponential — the longer you use it, the more you save

```
Week 1:  Cost $0.50 (embeddings) + $2 (LLM calls for knowledge)  = $2.50 invested
Week 2:  Agent recalls 10 past decisions instead of re-researching = $5-10 saved  
Week 4:  Knowledge base has 50+ items, bugs resolved in seconds   = $20-40 saved
Month 3: Team of 3 agents, zero repeated debugging, instant context = $100+ saved/month
```

> 💡 **The breakeven point is typically 3-5 days** of active usage. After that, every session is pure ROI.

### 2. Requires a Dedicated VM

Unlike local tools that run on your laptop, Cortex Hub needs a server:

- **Minimum:** 2 vCPU / 4 GB RAM ($4.50/mo on Hetzner)
- **Recommended:** 4 vCPU / 8 GB RAM for teams with 5+ agents
- **Why:** Qdrant vector DB + GitNexus AST graph + Node.js services need persistent compute

**Mitigation:** The VM cost ($4.50-30/mo) is negligible compared to:
- LLM API costs ($50-500/mo)
- Developer time saved (1+ hour/day × $50-100/hr)
- Prevented production bugs (each worth $500+)

### 3. Network Dependency

- Agents need network access to reach the Cortex Hub endpoint
- If the server goes down, agents lose code intelligence and memory (but can still work normally)
- Cloudflare Tunnel adds a dependency on Cloudflare's infrastructure (99.99% uptime)

**Mitigation:** Docker + Watchtower auto-restarts services. You can also run Cortex on your local network without Cloudflare for air-gapped teams.

### 4. Learning Curve

Agents need proper rules/instructions to use Cortex tools effectively:
- Without instructions, agents default to `grep_search` (old habits)
- The onboarding script auto-generates rules, but custom tuning improves results
- Session compliance grading helps train agents over time

> 🎯 **Bottom line:** Cortex Hub has real upfront costs (VM, embeddings, setup time). But the compound returns — knowledge that grows over time, bugs that never recur, context that never gets lost — make it a **net-positive investment within the first week** for any team using AI agents daily.

---

## System Requirements

### Minimum VM Specs

| Resource | Minimum | Recommended | Notes |
|----------|---------|-------------|-------|
| **CPU** | 2 vCPU | 4 vCPU | Qdrant vector search is CPU-intensive |
| **RAM** | 4 GB | 8 GB | Qdrant + GitNexus + Node.js services |
| **Disk** | 20 GB | 50 GB | Vector indices grow with knowledge base |
| **OS** | Ubuntu 22.04+ | Ubuntu 24.04 LTS | Any Linux with Docker 24+ works |
| **Network** | Outbound HTTPS | Static IP optional | Cloudflare Tunnel handles ingress |

### Cloud Provider Costs (Estimates)

| Provider | Instance | Monthly Cost |
|----------|----------|-------------|
| **Hetzner** | CX22 (2 vCPU / 4 GB) | ~€4/mo ($4.50) |
| **DigitalOcean** | Basic 4GB | $24/mo |
| **AWS** | t3.medium (2 vCPU / 4 GB) | ~$30/mo |
| **GCP** | e2-medium (2 vCPU / 4 GB) | ~$25/mo |
| **Azure** | B2s (2 vCPU / 4 GB) | ~$30/mo |

> 💡 **Best value:** Hetzner CX22 at ~$4.50/month handles 3-5 concurrent agents comfortably.

### Software Prerequisites

| Software | Version | Purpose |
|----------|---------|---------|
| Docker | 24+ | Container runtime |
| Docker Compose | v2 | Service orchestration |
| Node.js | 22 LTS | Build + runtime |
| pnpm | 9.x | Package management |
| Git | 2.x | Version control |
| Cloudflare account | Free tier | Secure tunnel exposure |

### Network Requirements

- **Outbound**: HTTPS (443) to Cloudflare, npmjs.org, Docker Hub
- **Inbound**: None — Cloudflare Tunnel handles all ingress
- **Internal**: Docker network between services (no host ports exposed)

---

## Token Efficiency Analysis

Cortex Hub reduces token consumption in two main ways:

### 1. Focused Search Results

| Action | Without Cortex | With Cortex | Token Savings |
|--------|---------------|-------------|---------------|
| Find function implementation | `grep` → 50 results, ~50K tokens | `code_search` → 3 flows, ~5K tokens | **~90%** |
| Understand symbol usage | Read 10 files manually, ~100K tokens | `code_context` → structured view, ~8K tokens | **~92%** |
| Check change impact | Manual review of imports, ~30K tokens | `code_impact` → dependency tree, ~3K tokens | **~90%** |

### 2. Knowledge Reuse

| Scenario | Without Cortex | With Cortex |
|----------|---------------|-------------|
| Known bug fix | 30 min debugging + 30K tokens | `knowledge_search` → 2 sec, ~500 tokens |
| Architecture context | Re-explain every session, ~5K tokens | `memory_search` → instant recall, ~500 tokens |
| Setup instructions | Re-discover every time, ~10K tokens | Stored once, recalled forever, ~500 tokens |

### 3. Transparent Dashboard Analytics

All these savings are not theoretical — they are tracked and surfaced in real-time in the Cortex Hub dashboard:
- **Global Savings:** View the total "Tokens Saved" and "Active Agents" on the Overview page.
- **Per-Session Savings:** Track exact token savings per individual agent session dynamically correlated from `query_logs`.
- **Top Tools Breakdown:** View which MCP tools (`code_search`, `memory_search`, etc.) are saving you the most tokens and developer time.

> **Estimated savings for a team of 3 agents over 1 month:** 500K-1M tokens (~$2-5 for Gemini, ~$5-15 for GPT-4o). Tracked automatically via the Cortex Hub Usage Dashboard.
