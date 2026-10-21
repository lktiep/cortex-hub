# Architecture

Cortex Hub runs as one Docker Compose stack (`infra/docker-compose.yml`). Agents talk to a single
endpoint, the MCP gateway; everything else stays on the compose network.

```
  Agents: Claude Code · Cursor · Windsurf · Antigravity · VS Code · Codex      Conductor workers (cw)
              │  MCP over HTTP, Bearer API key                                     │  WebSocket
              ▼                                                                    ▼
  ┌────────────────────────────────────────────────────────────────────────────────────────────┐
  │ cortex-mcp  :8318 → 8317   MCP gateway (apps/hub-mcp): 32 tools, key check, /ws/conductor     │
  └───────────────┬────────────────────────────────────────────────────────────────────────────┘
                  │ HTTP + INTERNAL_API_SECRET            WebSocket proxied as is
                  ▼
  ┌────────────────────────────────────────────────────────────────────────────────────────────┐
  │ cortex-api  :4000   API (apps/dashboard-api) + dashboard (apps/dashboard-web)                 │
  │   SQLite: projects, keys, sessions, knowledge, tasks, quality, usage                         │
  │   Conductor: dispatcher, scheduler, WebSocket server                                          │
  │   LLM gateway: /api/llm/v1/chat/completions, /api/llm/v1/embeddings                           │
  └──────┬──────────────────────┬──────────────────────┬──────────────────────┬───────────────┘
         ▼                      ▼                      ▼                      ▼
   qdrant :6333           gitnexus :4848          ollama                 llm-proxy
   vectors: code,         code graph, AST,        local embedding        OAuth-backed
   knowledge, memory      indexing                and chat models        model access

   watchtower: pulls new Cortex images and restarts those containers
```

Ports `6333`, `6334` and `4848` are published on `127.0.0.1` only; Ollama and the LLM proxy are not
published at all.

## The parts

| Container | Source | Role |
|---|---|---|
| `cortex-mcp` | `apps/hub-mcp` | The MCP server agents connect to (Hono, MCP SDK). Checks the API key, then calls the API. Also proxies `/ws/conductor` to the API with the same key check |
| `cortex-api` | `apps/dashboard-api`, `apps/dashboard-web` | The API (Hono, `better-sqlite3`) and the dashboard (Next.js). Holds all state, runs Conductor, and routes LLM calls |
| `cortex-gitnexus` | `infra/Dockerfile.gitnexus` | Clones and indexes repos into a code graph: symbols, calls, imports, execution flows |
| `cortex-qdrant` | `qdrant/qdrant` | Vector store for code chunks, knowledge and memories |
| `cortex-ollama` | `ollama/ollama` | Local models. The default embedder is `all-minilm` (384 dimensions); `bge-m3` is also pulled |
| `cortex-llm-proxy` | CLIProxyAPI | Model access through provider subscriptions (OAuth) |
| `cortex-watchtower` | Watchtower | Updates the Cortex containers when new images are published |

Outside the stack:

| Piece | Source | Role |
|---|---|---|
| Hooks and commands | `.claude/hooks`, `templates/`, written by the installer | Keep each agent on the workflow. See [Hooks](../reference/hooks) |
| Conductor worker | `apps/conductor-worker` | Runs tasks on a machine with an engine CLI. See [Run a worker](../conductor/workers) |
| VS Code extension | `apps/cortex-extension` | Makes each Antigravity, VS Code, Cursor or Windsurf window an agent on the conductor WebSocket |
| cortex-bar | `mods/cortex-bar` | Shows the session's cortex calls in Claude Code. See [Mods](../reference/mods) |

## How a call flows

1. The agent calls `cortex_code_search` with its API key.
2. `cortex-mcp` checks the key and its scope, then calls `cortex-api` with the internal secret.
3. `cortex-api` embeds the query through its LLM gateway, searches Qdrant (vector and BM25,
   fused), and returns ranked hits.
4. `cortex-mcp` appends what the agent should see with the answer: notes linked to the files in
   it (`📌 Known notes on these files`), hints (`💡 Cortex hints`) and Conductor notices for this
   key (`📋 Conductor`). It logs the call for `cortex_tool_stats`.

## Models

The LLM gateway in `cortex-api` resolves each request through the model routing set under
**LLM Providers**: a chain of provider accounts, tried in order, with usage logged and budgets
checked. Embeddings never need a chat model. Memory fact extraction, recipe capture and
knowledge self-repair do, and are off without one. See [Configuration](../reference/configuration).

## Further reading

- [Tech stack](./tech-stack)
- [Design decisions](./decisions)
- [Benchmarks](./benchmarks)
- The design notes in [`docs/architecture`](https://github.com/lktiep/cortex-hub/tree/master/docs/architecture)
  on GitHub. Some of them describe earlier versions.
