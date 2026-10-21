# Configuration

Cortex is configured in four places: the server's `infra/.env`, the hub's settings in the
dashboard, each project's `.cortex/` folder, and environment variables on the machines that run
agents and workers.

## Server: `infra/.env`

Copy `infra/.env.example` to `infra/.env` and fill it in. `docker compose` reads it. See
[Self-host](../guide/self-host) for the whole setup.

### Required

| Variable | Meaning |
|---|---|
| `MANAGEMENT_PASSWORD` | The key for the LLM proxy's management API. No default |

### Optional

| Variable | Default | Meaning |
|---|---|---|
| `GITNEXUS_AUTH_TOKEN` | generated | Bearer token for the code-graph service. Left empty, it is generated once and shared with the API through a volume |
| `DEFAULT_REPO` | none | A repo to index on first start |
| `GEMINI_API_KEY` | none | For Gemini embeddings or chat models |
| `PORT` | `4000` | Port of `cortex-api` |
| `DATABASE_PATH` | `/app/data/cortex.db` | SQLite file inside the container |
| `EXTERNAL_MCP_URL` | none | The public address agents connect to (`/mcp` is appended). Empty: the dashboard shows the address the first agent came through, else the local one |
| `EXTERNAL_API_URL`, `EXTERNAL_LLM_PROXY_URL` | none | The same, for the links on Settings |
| `BRANCH_RETENTION_DAYS` | `14` | Drop a branch's vectors after this many days without an index, or once it is merged or deleted. Never the default branch. `0` keeps all |
| `SESSION_IDLE_HOURS` | `72` | Mark an active session `expired` after this many hours without a tool call. `0` = never |
| `CORTEX_LLM` | follow Settings | `off`: never call a chat model. `on`: ignore the Settings switch |
| `MEMORY_LLM` | follow Settings | `off`: store memories as written, without fact extraction |
| `RECIPE_CAPTURE` | follow Settings | `off`: no recipes from finished tasks and sessions |
| `OLLAMA_MEMORY_LIMIT`, `OLLAMA_CPUS`, `OLLAMA_THREADS`, `QDRANT_MEMORY_LIMIT` | `4G`, `4`, `OLLAMA_CPUS`, `2G` | Resource limits |
| `CORTEX_IMAGE_NAMESPACE` | `ghcr.io/lktiep` | Where the Cortex images are pulled from |

Embeddings never need a chat model. Three features do: memory fact extraction, recipe capture and
knowledge self-repair. Without a routed chat model they are off.

### Access to the API

| Variable | Meaning |
|---|---|
| `API_AUTH` | `required`: `/api` answers only loopback, the MCP gateway, API keys and, with both `CF_ACCESS_*` set, browsers that passed Cloudflare Access. Unset or `off`: it answers anyone |
| `INTERNAL_API_SECRET` | Shared by `cortex-api` and `cortex-mcp`. Generate one with `openssl rand -hex 32` |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Your Cloudflare Access team domain and the application's audience tag |
| `API_BIND` | Address the API ports are published on. `127.0.0.1` keeps them on the host |

::: warning
The dashboard has no login of its own. Set `API_AUTH=required` and put the dashboard behind an
access proxy before it is reachable from outside. See
[Self-host](../guide/self-host#put-it-on-the-internet).
:::

## Hub settings

**Settings** on the dashboard holds the hub's own configuration: endpoints, LLM routing, the MCP
config to copy, notification preferences and how to run a worker. LLM providers and the models
used for chat and embeddings are set under **LLM Providers**.

Conductor reads these keys from the hub's `hub_config` table:

| Key | Default | Meaning |
|---|---|---|
| `conductor.defaultFallback` | `[{executor: "claude", model: "opus"}]` | Routes tried after a task's own |
| `conductor.branchTemplate` | `cx/{key}-{slug}` | Branch name for a task without `branch` |
| `conductor.offlineReclaimMinutes` | `30` | Minutes a worker may be offline before its task is taken back |
| `conductor.leaseHours` | `24` | Hours a task may run before it is taken back |
| `conductor.baseBranch` | the project's default branch, else `main` | Where task branches start |

Only `conductor.defaultFallback` is created when the hub first starts. The Settings route updates
keys that already exist, so the others keep their defaults unless a row is added to the table.

## Project: `.cortex/`

| File | Written by | Meaning |
|---|---|---|
| `project-profile.json` | installer, once | Detected stacks and package manager (`fingerprint`), the checks to run (`verify`), and an optional [`worker`](../conductor/workers#the-worker-section) section |
| `agent-identity.json` | installer | The agent's role and capabilities |
| `.hooks-version` | installer | The version of the hooks; a newer installer regenerates them |
| `.session-state/` | hooks | The [markers](./hooks#markers) the gates read. Ignored by git |

`project-profile.json` has `schema_version` `2.0`. Its `verify` section has `pre_commit`, `full`,
`auto_fix` and `max_retries`. The installer leaves an existing profile alone; edit it by hand.

## Agent machines

| Variable | Used by | Meaning |
|---|---|---|
| `HUB_MCP_URL`, `HUB_API_KEY` | installer, hooks | The hub's MCP endpoint and the key. See [Installer](./installer#environment) |
| `CORTEX_MCP_URL` | hooks | Takes precedence over `HUB_MCP_URL` |
| `CORTEX_NUDGE=off`, `CORTEX_NOTES=off` | hooks | Turn off the lookup nudge or file notes. See [Hooks](./hooks#switches) |

## Worker machines

See the full list under [`cw` environment variables](./cli#environment-variables). The ones most
often set:

| Variable | Meaning |
|---|---|
| `CORTEX_HUB_URL`, `CORTEX_API_KEY`, `CORTEX_AGENT_ID` | Hub, key and identity of the worker |
| `CORTEX_SETUP_CMD`, `CORTEX_TEST_CMD` | Override the project's setup and test commands on this machine |
| `CORTEX_WORKER_HOME` | Replaces `~/.cortex/worker` |
