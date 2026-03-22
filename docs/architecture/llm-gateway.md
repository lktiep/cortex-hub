# LLM API Gateway

> **Source**: [`apps/dashboard-api/src/routes/llm.ts`](../../apps/dashboard-api/src/routes/llm.ts)
> **Last updated**: 2026-03-22 — `bf90983`

## Overview

The LLM Gateway is a centralized proxy that all internal services use to access LLM providers. It provides:

- **Multi-provider fallback** with retry logic
- **Automatic usage logging** (exact token counts)
- **Budget enforcement** (daily + monthly limits)
- **Format translation** (Gemini ↔ OpenAI)
- **OpenAI-compatible API** regardless of actual provider

```
┌─────────────────────────────────────────────────────────────────┐
│                      Internal Consumers                         │
│  mem9-embedder │ MCP tools │ agents │ any internal service       │
└───────────┬─────────────────────────────────────────────────────┘
            │ POST /api/llm/v1/embeddings
            │ POST /api/llm/v1/chat/completions
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      LLM Gateway (llm.ts)                       │
│                                                                  │
│  1. checkBudget()   → daily_limit / monthly_limit               │
│  2. resolveChain()  → model_routing → provider_accounts         │
│  3. proxyRequest()  → try slot[0] → retry → slot[1] → ...      │
│  4. logUsage()      → INSERT INTO usage_logs                    │
│  5. return OpenAI-compatible response                           │
└───────────┬─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Provider APIs                               │
│  Gemini (embedContent / generateContent)                        │
│  OpenAI (v1/embeddings / v1/chat/completions)                   │
│  Anthropic, Mistral, or any OpenAI-compatible API               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Endpoints

### `POST /api/llm/v1/embeddings`

OpenAI-compatible embedding proxy.

**Request:**
```json
{
  "input": "text to embed",
  "model": "auto",
  "agent_id": "mem9-embedder",
  "project_id": "proj-704127e3"
}
```

- `model: "auto"` → uses full `model_routing.embedding` chain
- `model: "gemini-embedding-001"` → prioritizes matching slot, falls back to others
- `agent_id` → recorded in `usage_logs.agent_id` (default: `"internal"`)
- `project_id` → recorded in `usage_logs.project_id` (optional)

**Response** (always OpenAI format):
```json
{
  "object": "list",
  "data": [{ "object": "embedding", "embedding": [0.01, -0.02, ...], "index": 0 }],
  "model": "gemini-embedding-001",
  "usage": { "prompt_tokens": 375, "total_tokens": 375 }
}
```

### `POST /api/llm/v1/chat/completions`

OpenAI-compatible chat proxy.

**Request:**
```json
{
  "messages": [
    { "role": "system", "content": "You are helpful." },
    { "role": "user", "content": "Hello" }
  ],
  "model": "auto",
  "max_tokens": 500,
  "agent_id": "mcp-search",
  "project_id": "proj-704127e3"
}
```

**Response** (always OpenAI format):
```json
{
  "id": "chatcmpl-1711094400000",
  "object": "chat.completion",
  "model": "gemini-2.5-flash",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Hello!" },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 3,
    "total_tokens": 18
  }
}
```

---

## Provider Fallback Chain

### How Routing Works

The `model_routing` table stores ordered provider chains:

```sql
SELECT * FROM model_routing;
-- purpose   | chain
-- embedding | [{"accountId":"pa-gemini-xxx","model":"gemini-embedding-001"},
--           |  {"accountId":"pa-openai-yyy","model":"text-embedding-3-small"}]
-- chat      | [{"accountId":"pa-gemini-xxx","model":"gemini-2.5-flash"},
--           |  {"accountId":"pa-openai-yyy","model":"gpt-4o-mini"}]
```

Each chain entry references a `provider_accounts` row:

```sql
SELECT id, type, api_base, status FROM provider_accounts;
-- pa-gemini-xxx | gemini | https://generativelanguage.googleapis.com/v1beta | enabled
-- pa-openai-yyy | openai | https://api.openai.com/v1                       | enabled
```

### Fallback Algorithm

```
for each slot in chain:
  for attempt in 0..2:
    try:
      call provider (translate format if Gemini)
      log usage → return response ✅
    catch:
      if status in {429, 502, 503, 504} and attempt < 2:
        sleep(1s * 2^attempt)  → retry same slot
      else:
        break → try next slot
      
if all slots exhausted → return 502 with error details
```

### Format Translation

| Provider | Embedding API | Chat API |
|----------|--------------|----------|
| **Gemini** | `POST /models/{model}:embedContent?key=...` → `{content: {parts: [{text}]}}` | `POST /models/{model}:generateContent?key=...` → `{contents, systemInstruction}` |
| **OpenAI** (and compatible) | `POST /embeddings` → `{model, input}` with `Bearer` auth | `POST /chat/completions` → `{model, messages}` with `Bearer` auth |

The gateway auto-detects provider type from `provider_accounts.type` or `api_base` URL and applies the correct format.

---

## Token Counting & Usage Logging

### How Tokens Are Counted

| Provider | Embedding tokens | Chat tokens |
|----------|-----------------|-------------|
| **OpenAI** | Exact from `response.usage.total_tokens` | Exact from `response.usage.{prompt,completion}_tokens` |
| **Gemini embedding** | Estimated: `Math.ceil(text.length / 4)` (Gemini API doesn't return token counts for embeddings) |
| **Gemini chat** | Exact from `response.usageMetadata.{promptTokenCount, candidatesTokenCount}` |

### usage_logs Schema

```sql
CREATE TABLE usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,           -- e.g. 'mem9-embedder', 'mcp-search', 'internal'
  model TEXT,              -- e.g. 'gemini-embedding-001', 'gpt-4o-mini'
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  project_id TEXT,         -- nullable, links to projects table
  request_type TEXT,       -- 'embedding' or 'chat'
  created_at TEXT DEFAULT (datetime('now'))
);
```

Each gateway call = **1 row** in `usage_logs`. The Dashboard Usage page reads from this table for:
- Total requests / tokens
- Daily/weekly trend chart
- Breakdown by model
- Breakdown by agent

---

## Budget Enforcement

### Settings

```sql
CREATE TABLE budget_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  daily_limit INTEGER DEFAULT 0,   -- 0 = unlimited
  monthly_limit INTEGER DEFAULT 0, -- 0 = unlimited
  alert_threshold REAL DEFAULT 0.8,
  updated_at TEXT
);
```

Configured via Dashboard → Usage → Budget Settings.

### Enforcement Flow

```
1. Gateway receives request
2. checkBudget():
   a. Read budget_settings (id=1)
   b. SUM(total_tokens) FROM usage_logs WHERE today → dailyUsed
   c. SUM(total_tokens) FROM usage_logs WHERE this_month → monthlyUsed
   d. If dailyUsed >= daily_limit → return 429 "Daily token budget exceeded"
   e. If monthlyUsed >= monthly_limit → return 429 "Monthly token budget exceeded"
3. If OK → proceed to proxy
```

> **Note**: Budget check happens *before* the API call, so the last allowed request may slightly exceed the limit. This is by design — blocking mid-batch would cause more issues than allowing a small overshoot.

---

## Internal Consumer Integration

### mem9-embedder

Routes through gateway via `gatewayUrl` option in the `Embedder` class:

```typescript
// mem9-embedder.ts
const GATEWAY_URL = process.env.LLM_GATEWAY_URL ?? 'http://localhost:4000/api/llm'
const embedder = new Embedder(embedConfig, chain, {
  maxRetries: 2,
  retryDelayMs: 2000,
  gatewayUrl: GATEWAY_URL,
})
```

When `gatewayUrl` is set, `Embedder.embed()` calls `POST {gatewayUrl}/v1/embeddings` instead of calling Gemini/OpenAI directly. The gateway handles routing, fallback, and usage logging.

### Future consumers (MCP tools, agents)

Any service can use the gateway by calling:
```
POST http://localhost:4000/api/llm/v1/embeddings
POST http://localhost:4000/api/llm/v1/chat/completions
```

Or externally via:
```
POST https://cortex-api.jackle.dev/api/llm/v1/embeddings
POST https://cortex-api.jackle.dev/api/llm/v1/chat/completions
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_GATEWAY_URL` | `http://localhost:4000/api/llm` | Gateway URL for internal consumers |
| `LLM_PROXY_URL` | `http://localhost:8317` | Legacy CLIProxy URL |
| `CLIPROXY_MANAGEMENT_KEY` | `cortex2026` | CLIProxy management auth |

---

## Adding a New Provider

1. **Create provider account** in Dashboard → LLM Providers → Add Provider
   - Enter API key, select type (`gemini` / `openai` / `anthropic` / `mistral`)
   - Gateway auto-discovers available models
2. **Configure routing** in Dashboard → LLM Providers → Model Routing
   - Add the provider's model to the embedding/chat chain
   - Order determines fallback priority (first = primary)
3. **No code changes needed** — the gateway reads `model_routing` + `provider_accounts` dynamically

If the new provider uses **OpenAI-compatible API** (most do), it works automatically.
If the provider uses a custom API format, add a `{embed,chat}Via{Provider}` function in `llm.ts`.
