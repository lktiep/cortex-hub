# Self-host the hub

The hub is a Docker Compose stack in `infra/`. One Linux server with Docker 24 or newer runs all
of it: 2 vCPU, 4 GB of RAM and 20 GB of disk at minimum.

## Start it

```bash
git clone https://github.com/lktiep/cortex-hub.git
cd cortex-hub
cp infra/.env.example infra/.env
# edit infra/.env: MANAGEMENT_PASSWORD is required
cd infra && docker compose up -d
```

Compose refuses to start without `MANAGEMENT_PASSWORD` ("Set MANAGEMENT_PASSWORD in .env"). It is
the management key of the LLM gateway, and the only credential for its `/v0/management/*` routes.

When the containers are up:

| What | Where |
|---|---|
| Dashboard and REST API | `http://localhost:4000` (also published on 3000 and 3080) |
| MCP endpoint for agents | `http://localhost:8318/mcp` |

Open the dashboard. `/setup` walks you through choosing an LLM provider, signing in to it and
picking models. Then create API keys under **API Keys**, and continue with the
[quick start](./quick-start) on each developer machine.

## The services

| Service | Image | Port on the host | Role |
|---|---|---|---|
| `cortex-api` | `cortex-api` | `${API_BIND:-0.0.0.0}:4000` | REST API, Conductor, serves the dashboard |
| `cortex-mcp` | `cortex-mcp` | `8318` → 8317 | The MCP endpoint agents connect to |
| `gitnexus` | `cortex-gitnexus` | `127.0.0.1:4848` | AST code graph and indexing |
| `qdrant` | `qdrant/qdrant:v1.13.6` | `127.0.0.1:6333`, `6334` | Vector store |
| `ollama` | `ollama/ollama:0.34.4` | none | Local embeddings |
| `llm-proxy` | `eceasy/cli-proxy-api` | none | LLM gateway (CLIProxy) |
| `watchtower` | `containrrr/watchtower` | none | Pulls new Cortex images |

The three Cortex images have both an `image` and a `build` entry. Compose uses the images under
`CORTEX_IMAGE_NAMESPACE` (default `ghcr.io/lktiep`), or builds them from your checkout with
`docker compose build`.

Data lives in named volumes: `qdrant-data`, `api-data` (the SQLite database), `gitnexus-data`,
`cliproxy-auth` and `ollama-models`.

## Put it on the internet

Agents on other machines need to reach `cortex-mcp`. The project's own setup runs a Cloudflare
Tunnel, so no port is opened on the host. Whatever you use, set these in `infra/.env`:

| Variable | Why |
|---|---|
| `EXTERNAL_MCP_URL` | The address agents connect to (`/mcp` is appended). The dashboard shows it in **Settings** and in the worker command. Empty: it shows the https address an agent last connected through. |
| `API_AUTH=required` | `/api` then answers only loopback, the MCP gateway, API keys, and browsers that passed Cloudflare Access (with both `CF_ACCESS_*` set). Unset, it answers anyone. |
| `INTERNAL_API_SECRET` | Shared by `cortex-api` and `cortex-mcp`. Generate with `openssl rand -hex 32`. |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Your Cloudflare Access team domain and application audience tag. |
| `API_BIND=127.0.0.1` | Publish the API ports to this host only, enough for a `cloudflared` on it. |

::: danger The dashboard has no user login
Anyone who can open the dashboard can manage keys and approve user gates. Keep it behind access
control such as Cloudflare Access, and set `API_AUTH=required`.
:::

Every variable is listed in [Environment and config](../reference/configuration).

## Index your code

On the dashboard, create a project under **Organizations**, open it and use **Connect Git
Repository** (the repo URL, plus a username and token for a private repo). Or set `DEFAULT_REPO`
to index one repo on first start. After each push, agents call `cortex_code_reindex(repo, branch)` to keep the graph
fresh. Branch indexes are dropped after `BRANCH_RETENTION_DAYS` (default 14) without an index, or
once the branch is merged or deleted; the default branch is never dropped.

## Updates

Watchtower polls every 300 seconds and only updates containers labelled for it: `cortex-api`,
`cortex-mcp` and `gitnexus`. Releases are cut from CI (see [Scripts](../reference/scripts#release)),
which tags images `v<version>` and `stable`.

## Older install scripts

`scripts/bootstrap.sh` (a menu for admin install, member onboarding and uninstall) and
`scripts/install-hub.sh` (checks Docker and pnpm, copies the env file, runs Compose and a health
check) still exist. The steps above are what the current `infra/` expects.
