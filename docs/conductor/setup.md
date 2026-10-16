# Conductor setup (per machine)

This page sets up one machine for the Conductor: its tools, its engines, and a worker that
connects to your hub. Commands were checked against the vendors' pages on 2026-10-17 (see
[Sources](#sources)). Where a line could not be checked, it says so.

Placeholders used below: `https://<your-mcp-host>` (your hub), `<lead-api-key>` and
`<worker-api-key>`. Replace them with your own values.

## 1. Roles

- **One lead.** A Claude Code session that plans the work. It uses the lead key.
- **Any number of worker machines.** Each runs one or more workers. A worker does one task at a
  time. To run two tasks on one machine, start a second worker with its own `--agent-id`.
- **The hub dispatches.** Nobody pushes tasks to a worker by hand.

## 2. API keys

Create two kinds of key in Dashboard, Settings, API Keys:

- `lead`, for the lead's Claude Code session.
- `worker-<host>`, one per worker machine.

Why separate keys: the hub addresses lead notices by key name. If a worker's engine shared the
lead's key, the engine's own tool calls could consume the lead's notices.

Limit: on a machine that is both lead and worker, the engines read the same MCP config as the
lead, so they use the lead key. The dashboard still shows everything. Prefer a separate machine
(or a separate OS user) for workers.

## 3. Prerequisites

Each worker machine needs:

- **Node 20 or newer.** Check with `node --version`.
- **git.** Check with `git --version`.
- **gh, logged in** with `gh auth login` (optional). Without it, the worker reports a compare URL
  instead of opening a pull request.
- A clone of the project, with a git remote named `origin`. Run the worker inside it.

#### macOS

- Node: download from <https://nodejs.org/en/download>.
- git: `brew install git` or `xcode-select --install`.
- gh: `brew install gh`.

#### Linux

- Node: download from <https://nodejs.org/en/download>.
- git: `sudo apt-get install git` (Debian, Ubuntu) or `sudo dnf install git` (Fedora).
- gh: follow <https://github.com/cli/cli/blob/trunk/docs/install_linux.md>.

#### Windows

- Node: download from <https://nodejs.org/en/download>.
- git: get the installer from <https://git-scm.com/install/windows> (unverified — check the
  vendor page).
- gh: `winget install --id GitHub.cli --source winget`.

Then run `gh auth login` on every OS.

## 4. Engines

Install at least one engine, log in to it once, and check that it works. The worker looks for
`agy`, `claude`, `codex` and `gemini` (in that order) and uses what it finds.

#### macOS and Linux

```bash
# claude
curl -fsSL https://claude.ai/install.sh | bash
claude                 # log in once, then exit

# codex
npm install -g @openai/codex
codex login            # then follow the browser flow

# gemini
npm install -g @google/gemini-cli
gemini                 # sign in once, then exit

# agy (Antigravity CLI)
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy                    # sign in once, interactively
agy models             # check it works (see note below)
```

#### Windows

```powershell
# claude
irm https://claude.ai/install.ps1 | iex
claude                 # log in once, then exit

# codex
npm install -g @openai/codex
codex login

# gemini
npm install -g @google/gemini-cli
gemini                 # sign in once, then exit

# agy (Antigravity CLI)
irm https://antigravity.google/cli/install.ps1 | iex
agy                    # sign in once, interactively
agy models
```

Notes:

- `agy models` is how the worker lists models. The vendor page names `agy --version` as its
  install check; `agy models` is not on the vendor's install page (unverified — check the
  vendor page).
- Gemini CLI is replaced by Antigravity CLI for unpaid and Google One users (per the Gemini CLI
  README). Use `agy` if `gemini` does not fit your account.
- **agy on Windows has no `--mode auto`.** The worker uses `accept-edits` there.
- **agy starts slowly** (about 2 minutes), almost all of it spent starting its MCP servers. Remove
  MCP servers you do not need from its config to speed it up.
- **agy quota is per model family**, not per account. One family can run out while another works.

## 5. Point each engine at the hub

The engines call hub tools (for example to report progress), so each one needs a `cortex-hub`
MCP entry with the worker key. The worker also reads these files to find the hub URL and key
(see "Install a worker" below), so a worker key here is enough.

#### Claude Code

```bash
claude mcp add --transport http --scope user cortex-hub https://<your-mcp-host>/mcp \
  --header "Authorization: Bearer <worker-api-key>"
```

The same entry as JSON (in `~/.claude.json` under `mcpServers`). The `"type": "http"` line is
required: Claude Code reads an entry without `type` as a stdio server.

```json
{
  "mcpServers": {
    "cortex-hub": {
      "type": "http",
      "url": "https://<your-mcp-host>/mcp",
      "headers": { "Authorization": "Bearer <worker-api-key>" }
    }
  }
}
```

#### agy (Antigravity CLI)

`~/.gemini/antigravity/mcp_config.json`, in the `mcp-remote` form that `scripts/onboard.sh`
writes:

```json
{
  "mcpServers": {
    "cortex-hub": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-mcp-host>/mcp", "--header", "Authorization: Bearer <worker-api-key>"],
      "env": { "HUB_API_KEY": "<worker-api-key>" }
    }
  }
}
```

The vendor's MCP page describes a different file (`~/.gemini/config/mcp_config.json`) and a
direct form with `serverUrl` and `headers`, without `mcp-remote`. The worker reads the
`antigravity/` path above. If your agy build uses the vendor's path, put the entry there too
(unverified on this branch — check the vendor page).

#### Codex

`~/.codex/config.toml`, in the form `scripts/onboard.sh` writes:

```toml
[mcp_servers.cortex-hub]
command = "npx"
args = ["-y", "mcp-remote", "https://<your-mcp-host>/mcp", "--header", "Authorization: Bearer <worker-api-key>"]

[mcp_servers.cortex-hub.env]
HUB_API_KEY = "<worker-api-key>"
```

Codex can also reach a remote server directly with `url = "https://<your-mcp-host>/mcp"` and
`bearer_token_env_var = "<NAME OF AN ENV VAR HOLDING THE KEY>"` (from the vendor page).

#### Cursor

`~/.cursor/mcp.json`, in the form `scripts/onboard.sh` writes:

```json
{
  "mcpServers": {
    "cortex-hub": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<your-mcp-host>/mcp", "--header", "Authorization: Bearer <worker-api-key>"],
      "env": { "HUB_API_KEY": "<worker-api-key>" }
    }
  }
}
```

> **Warning.** `agy mcp list` prints MCP server secrets in plain text. Never run it where others
> can see the screen, and never paste its output anywhere.
>
> To check which hub agy points at, print only the URL:
>
> ```bash
> node -e "const c=require(require('os').homedir()+'/.gemini/antigravity/mcp_config.json');const s=(c.mcpServers||{})['cortex-hub']||{};console.log(s.url||s.serverUrl||(s.args||[]).find(a=>/^https?:/.test(a))||'no cortex-hub entry')"
> ```
>
> If it is not the current hub, edit the file, or rerun `scripts/onboard.sh`.
>
> This reads `~/.gemini/antigravity/mcp_config.json`. If your agy build keeps its config at the
> vendor path, it reports no entry; in that case pass `--api-key` or set `CORTEX_API_KEY`.

The worker takes the hub URL from `--hub`, then `CORTEX_HUB_URL`, then the first `cortex-hub` entry
it finds in `~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/antigravity/mcp_config.json`
and `~/.cursor/mcp.json`, in that order. The key comes from `--api-key`, then `CORTEX_API_KEY`,
then the entry for the same hub in those files.

#### VS Code extension

The Cortex extension finds the hub in this order: the `cortexHub.hubUrl` setting (empty by
default), then the `CORTEX_HUB_WS_URL` or `CORTEX_HUB_URL` env var, then the MCP config it
detects (Claude Code, `.mcp.json`, Gemini, Antigravity, Cursor, Windsurf, VS Code). It does not
read `~/.codex/config.toml`. At activation it logs `hubSource` (`setting`, `env:<NAME>`, a config
path or `default`) so you can see which one won. It never logs the key.

## 6. Install a worker

Run this inside a clone of the project. It downloads the worker to
`~/.cortex/worker/cortex-worker.mjs` and starts it in the background.

#### macOS and Linux

```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.sh | CORTEX_API_KEY=<worker-api-key> bash -s -- start --daemon --hub https://<your-mcp-host>
```

#### Windows

```powershell
$env:CORTEX_API_KEY="<worker-api-key>"; iwr -useb https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.ps1 -OutFile $env:TEMP\run-agent.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\run-agent.ps1 start --daemon --hub https://<your-mcp-host>
```

The Windows line runs the script with `-ExecutionPolicy Bypass`, which applies to that one
process only. Your machine's policy is not changed.

Options (add them after `start`):

| Flag | Meaning |
|---|---|
| `--agent-id <id>` | Worker name. Default: `CORTEX_AGENT_ID`, else `<host>-<repo folder>`. Use a different one for each worker on a machine. |
| `--repo <path>` | The clone to work in. Default: the current directory. |
| `--engines claude,agy` | Engines to look for, in order. Default: `agy,claude,codex,gemini`. |
| `--capabilities a,b` | Tags the hub can match tasks on. Use ids from the hub's `.cortex/capability-templates.json` (`plan, orchestrate, backend, frontend, design, review, godot, resources, game-logic, server, build-game, database, devops, security, testing, docker, deploy`). Unknown tags are dropped, with a warning on the hub. |
| `--hub <url>`, `--api-key <key>` | Override the detected hub and key. |

There is no `cortex-worker` command on your PATH. After the first run, call the worker with node:

- macOS and Linux: `node ~/.cortex/worker/cortex-worker.mjs <command>`
- Windows: `node $HOME\.cortex\worker\cortex-worker.mjs <command>`

You can also re-run the bootstrap with the command, for example `... bash -s -- doctor --hub ...`.

State, the pid file and the log live in `~/.cortex/worker/<agentId>/`. Task worktrees are under
`~/.cortex/worker/<agentId>/wt/`.

## 7. Check it

Run this inside the clone:

```bash
node ~/.cortex/worker/cortex-worker.mjs doctor
```

On Windows: `node $HOME\.cortex\worker\cortex-worker.mjs doctor`. Add `--probe` to also send a
tiny prompt through each engine, which proves its login works. Doctor prints one line per check,
with a fix under each failure. A required check that fails makes the exit code 1.

| Row | What it checks | If it fails |
|---|---|---|
| `node` | Node 20 or newer | Install Node 20 or newer. |
| `git` | `git --version` works | Install git from <https://git-scm.com>. |
| `gh` (optional) | `gh auth status` | Run `gh auth login`, or install gh from <https://cli.github.com>. Until then the worker reports compare URLs. |
| `engine <name>` (one per engine, optional) | The CLI is found. With `--probe`, it also answers. | Install it and log in once by hand (section 4). |
| `engines` | At least one engine is usable | Same as the row above. |
| `hub config` | A hub URL and key were found | Pass `--hub` and `--api-key`, or set `CORTEX_HUB_URL` and `CORTEX_API_KEY`. |
| `hub health` | `<hub>/health` answers 200 | Check the hub URL and your network, and that the hub is running. |
| `worker version` (optional) | Same version as the hub serves | `node ~/.cortex/worker/cortex-worker.mjs update`. |
| `handshake` | The hub accepts the key and sends its welcome | Check the key in `--api-key`, `CORTEX_API_KEY` or the MCP config. `closed 4001` or `closed 4003` (or a 401 from a proxy) means a rejected key; see section 10. |
| `origin` | The repo has a remote named `origin` | Run doctor inside a clone, or pass `--repo <path>`. |
| `project mapping` (optional) | Shows the project the hub mapped this repo to | Reads "unknown until first start" before the worker has connected once. |
| `engine MCP configs` (optional) | No engine's MCP entry points at a different hub | Edit the file it names so the `cortex-hub` URL is the worker's hub. |

The key is validated by the `handshake` row. There is no separate key row.

## 8. Run as a daemon

```bash
node ~/.cortex/worker/cortex-worker.mjs start --daemon   # or -d; output goes to the log
node ~/.cortex/worker/cortex-worker.mjs status           # running? task? last registration
node ~/.cortex/worker/cortex-worker.mjs logs -f          # last 200 lines, then follow
node ~/.cortex/worker/cortex-worker.mjs stop             # waits for a running task to wrap up
node ~/.cortex/worker/cortex-worker.mjs update           # fetch the hub's worker version
```

Use `--agent-id <id>` with `status`, `logs` and `stop` when you run more than one worker on a
machine. After `update`, stop and start the worker to use the new version.

The daemon does not survive a reboot. Nothing restarts it, so run `start --daemon` again after a
restart. Starting it on boot is not covered here.

## 9. Lead setup

On the lead's machine, add the hub to Claude Code with the **lead** key (the Claude Code snippet in
section 5, with `<lead-api-key>`). Start a Claude Code session in the project and say:

> Read `scripts/orchestrator-prompt.md` and act as the conductor lead.

Gates that need the user are approved in `/conductor` on the dashboard. The lead cannot close
them through MCP.

## 10. Troubleshooting

Close codes from the hub:

| Code | Meaning |
|---|---|
| 4001 | No key was sent (also sent when `agentId` is missing). |
| 4003 | The key is wrong, or it is scoped to a different project than this repo. |
| 4000 | Replaced by a newer connection from the same host with the same agent id. |
| 4009 | That agent id is in use by another host. Pass `--agent-id <id>`. |

When the hub refuses a worker for good, `start` exits with code 2 and the log says why.

Why a task waits (shown on the dashboard):

| Reason | Meaning |
|---|---|
| `capacity` | Every route that could run the task is out of quota until the reset time shown. Wait, or reroute it to a model with quota (`cortex_task_route`). |
| `no_worker` | No connected worker can take it. Start one, or check its engines. |
| `lock` | Another task holds a lock on the same files. |

Other problems:

- The extension shows a URL with `/ws/conductor/ws/conductor`: update the extension.
- `agy` is slow to start: see the notes in section 4.
- A task ran against the wrong hub: run `doctor` and read the `engine MCP configs` row.

## 11. Security

- MCP configs hold API keys in plain text. Keep them private and do not paste them into chats,
  tickets or logs.
- The dashboard API has no user login. Keep the dashboard behind access control. Gate approval
  (the user-only gates) guards against agents, not against people.

## Sources

All checked 2026-10-17.

- Node.js: <https://nodejs.org/en/download> (install commands not shown in the fetched copy)
- git: <https://git-scm.com/install/mac>, <https://git-scm.com/install/linux> (Windows page not read)
- gh: <https://github.com/cli/cli#installation>, <https://github.com/cli/cli/blob/trunk/docs/install_macos.md>, <https://github.com/cli/cli/blob/trunk/docs/install_windows.md>, <https://cli.github.com/manual/gh_auth_login>
- Claude Code install and login: <https://code.claude.com/docs/en/quickstart>
- Claude Code MCP: <https://code.claude.com/docs/en/mcp>
- Codex install: <https://github.com/openai/codex>
- Codex login: <https://learn.chatgpt.com/docs/auth>
- Codex MCP: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>
- Gemini CLI: <https://github.com/google-gemini/gemini-cli>
- Antigravity CLI install: <https://antigravity.google/docs/getting-started?tab=cli>
- Antigravity CLI sign-in: <https://antigravity.google/docs/install?tab=cli>
- Antigravity MCP: <https://antigravity.google/docs/mcp>
