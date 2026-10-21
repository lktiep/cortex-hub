# What is Cortex Hub

Cortex Hub is a backend you host yourself. Your AI coding agents connect to it over one
[MCP](https://modelcontextprotocol.io/) endpoint, and through it they share memory, team
knowledge, a code graph of every indexed repo, quality gates and a task queue.

```
   Claude Code   Cursor   Windsurf   VS Code   Antigravity   Codex
        │           │         │          │           │          │
        └───────────┴─────────┴────┬─────┴───────────┴──────────┘
                                   │  MCP over HTTP, API key
                         ┌─────────▼──────────┐
                         │   cortex-mcp       │  32 tools
                         ├────────────────────┤
                         │   cortex-api       │  REST, dashboard, Conductor
                         │   Qdrant           │  vectors
                         │   GitNexus         │  AST code graph
                         │   SQLite (WAL)     │  sessions, tasks, knowledge
                         │   Ollama           │  local embeddings
                         │   llm-proxy        │  LLM gateway
                         └────────────────────┘
```

## What an agent gets

| Area | Tools | Read more |
|---|---|---|
| Sessions | `cortex_session_start`, `cortex_session_end`, `cortex_changes` | [Sessions and recall](./sessions) |
| Code | `cortex_code_search`, `cortex_code_context`, `cortex_code_impact`, `cortex_detect_changes`, `cortex_cypher`, `cortex_list_repos`, `cortex_code_reindex` | [Code intelligence](./code-intelligence) |
| Knowledge and memory | `cortex_knowledge_*`, `cortex_memory_*`, `cortex_file_notes` | [Knowledge and memory](./knowledge-memory) |
| Quality | `cortex_quality_report`, `cortex_plan_quality`, `cortex_tool_stats` | [Quality gates](./quality-gates) |
| Orchestration | `cortex_task_*`, `cortex_agents` | [Conductor](../conductor/overview) |

All 32 are listed with their parameters in the [MCP tools reference](../reference/mcp-tools).

## What runs on your machine

The hub alone is passive: an agent has to call it. What makes agents call it reliably is the
part installed into each project by [`scripts/install.sh`](../reference/installer):

- **MCP config** for each IDE it finds, pointing at your hub.
- **`/cs` and `/ce`**, the slash commands that open and close a session.
  See [Slash commands](../reference/slash-commands).
- **Eight Claude Code hooks** that block edits until the session has recalled what the team
  knows, and block commits until build, typecheck and lint pass.
  See [Hooks](../reference/hooks).
- **Rules files** for Cursor, Windsurf, VS Code Copilot and Codex that tell those agents the
  same workflow.

For multi-agent work, a machine can also run a [worker](../conductor/workers) (`cw`), which
takes tasks from the hub and runs them with a local engine (`agy`, `claude`, `codex` or
`gemini`).

## Where to go next

- Already have a hub URL and key? [Quick start](./quick-start).
- Need a hub? [Self-host it](./self-host) with Docker Compose.
- Want to see the orchestration? Open the [Conductor showcase](/cortex-hub/conductor/index.html){target="_self"}.

## Requirements and cost

From the project README:

| Resource | Minimum | Recommended |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk | 20 GB | 50 GB |
| OS | Ubuntu 22.04+ | Ubuntu 24.04 LTS (any Linux with Docker 24+) |

All services run in Docker on your server. The README puts the cost at about $5 a month for a
small VPS, plus whatever LLM usage you route through the gateway. Cortex Hub is MIT licensed.
