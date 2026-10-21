# `cw`: the worker CLI

`cw` is the command line of the Conductor worker (`apps/conductor-worker`, published as the
single file `cortex-worker.mjs`). The worker bootstrap installs it; see
[Run a worker](../conductor/workers#install-and-start). It needs Node 20 or newer.

```
cw <command> [agent] [options]
```

`[agent]` is an agent name or its number in `cw ls`. Without `cw` on the PATH, run
`node ~/.cortex/worker/cortex-worker.mjs <command>`.

## Commands

| Command | What it does |
|---|---|
| `cw ls` | Lists the agents on this machine, numbered, with running state |
| `cw start [agent]` | Starts a worker in the foreground; `-d` runs it in the background. Takes a name, not a number |
| `cw stop [agent]` | Stops a background worker, waiting up to 90 s for a running task to push its work. `--all` stops every agent |
| `cw restart [agent]` | Stops it and starts it in the background with the settings it last started with. `--all` for every agent |
| `cw status [agent]` | Running state, current task, last registration with the hub. Without an agent, lists agents |
| `cw logs [agent]` | The last 200 lines of the worker's log; `-f` follows |
| `cw tail [agent]` | The end of what the engine printed on the latest task; `-f` follows |
| `cw update` | Replaces `cortex-worker.mjs` with the version your hub serves |
| `cw hub-url` | Prints the hub URL the worker would use |
| `cw doctor` | Checks the setup step by step; `--probe` also runs each engine once |
| `cw check` | Lists what this machine lacks for the repo, offers to install it, then trial-runs the setup and test commands |
| `cw version` | Prints the version |
| `cw help` | Prints the help |

Left out, `[agent]` means this repo's agent, or the only agent on the machine; with several, `cw`
asks which.

## Options

| Option | Meaning |
|---|---|
| `-d`, `--daemon` | `start` in the background; output goes to the log |
| `-f`, `--follow` | `logs`, `tail`: keep printing new lines |
| `--all` | `stop`, `restart`: every agent on the machine |
| `--agent-id <id>` | Worker identity. Default: `CORTEX_AGENT_ID`, else `<host>-<repo folder>`, lowercased and cut to 64 characters |
| `--repo <path>` | The repo to work in. Default: the current directory |
| `--engines <list>` | Engines to look for, in order. Default `agy,claude,codex,gemini` |
| `--capabilities <list>` | Capability tags the hub can match tasks on |
| `--hub <url>` | Hub URL. Default: `CORTEX_HUB_URL`, else the `cortex-hub` MCP config |
| `--api-key <key>` | API key. Default: `CORTEX_API_KEY`, else the `cortex-hub` MCP config |
| `--engine-timeout <min>` | Minutes an engine may run per task. Default 90 |
| `--probe` | `doctor`: also run a tiny prompt through each engine |
| `-y`, `--yes` | `check`: install what is missing without asking |
| `--if-changed` | `check`: skip the trial run if it passed before and nothing it rests on has changed |

`--all` works only with `stop` and `restart`; `--yes` and `--if-changed` only with `check`. `cw`
refuses other combinations.

### Capability tags

`plan`, `orchestrate`, `backend`, `frontend`, `design`, `review`, `godot`, `resources`,
`game-logic`, `server`, `build-game`, `database`, `devops`, `security`, `testing`, `docker`,
`deploy`. A task's `requiredCapabilities` must all be on the worker.

## Where the hub URL and key come from

1. `--hub` / `--api-key`
2. `CORTEX_HUB_URL` / `CORTEX_API_KEY`
3. The first `cortex-hub` MCP entry in `~/.claude.json`, `~/.codex/config.toml`,
   `~/.gemini/antigravity/mcp_config.json`, `~/.gemini/config/mcp_config.json`,
   `~/.cursor/mcp.json`, in that order. The key is taken from the entry for the same hub.

`cw hub-url` prints the result.

## `cw doctor`

Checks, in order: `node`, `git`, `gh` (optional), each engine, the engines together, the hub
config, hub health, the worker version against the hub's, the handshake, the git origin, the
project mapping on the hub, and the engines' MCP configs.

## `cw check`

See [Will it run my project?](../conductor/workers#will-it-run-my-project-cw-check). Exit code 0
means ready, 1 means not.

## Environment variables

| Variable | Meaning |
|---|---|
| `CORTEX_API_KEY`, `CORTEX_HUB_URL`, `CORTEX_AGENT_ID` | Defaults for `--api-key`, `--hub`, `--agent-id` |
| `CORTEX_SETUP_CMD`, `CORTEX_TEST_CMD` | Override the project's setup and test commands on this machine |
| `CORTEX_GH_BIN` | Path of the `gh` binary |
| `CORTEX_AGY_BIN` | Path of the `agy` binary |
| `CORTEX_AGY_MODE` | agy's permission mode. Default `accept-edits`; `auto` is the other choice |
| `CORTEX_AGY_SKIP_PERMISSIONS=1` | Opt in to agy's `--dangerously-skip-permissions` |
| `CORTEX_WORKER_HOME` | Replaces `~/.cortex/worker` |
| `CORTEX_SKIP_READINESS=1` | Take tasks without the readiness check |
| `CORTEX_SKIP_CHECK=1` | The bootstrap skips `cw check` |
| `CORTEX_SKIP_CW=1` | The bootstrap does not install `cw` |

The worker sets `CORTEX_WIP_PUSH=1` for the git hooks of a work-in-progress push, so a project's
pre-push hook can skip slow checks for unfinished work. `CORTEX_WORKER_DAEMON` is internal.

`start.json` keeps the repo, hub, engines, capabilities, timeout and the `CORTEX_SETUP_CMD`,
`CORTEX_TEST_CMD`, `CORTEX_GH_BIN`, `CORTEX_SKIP_READINESS` and `CORTEX_AGY_*` values, so `cw
restart` starts the worker the same way. It stores the key only when it came from `--api-key` or
`CORTEX_API_KEY`.

## Files

`~/.cortex/worker/cortex-worker.mjs` is the worker. Per agent, `~/.cortex/worker/<agentId>/`
holds `worker.pid`, `worker.log`, `state.json`, `worker.stop`, `start.json` (mode 600), `wt/`
(worktrees) and `tasks/<taskId>.log` (the newest 10, 10 MB each).

## Exit and close codes

| Code | Meaning |
|---|---|
| 4001 | Connection closed: no API key |
| 4003 | Connection closed: the key is wrong or out of scope |
| 4000 | Connection closed: replaced by a newer connection with the same agent id |
| 4009 | Connection closed: the agent id is in use |
| exit 2 | The hub refused the worker for good; retrying will not help |
