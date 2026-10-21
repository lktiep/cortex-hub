# Run a worker

A worker is a small Node program, `cortex-worker.mjs`, that connects a machine to the hub, takes
Conductor tasks and runs them with a coding engine installed on that machine. `cw` is its command
line. The full list of commands and flags is in the [`cw` reference](../reference/cli).

## Before you start

- Node 20 or newer, and git. `gh` is optional; without it the worker reports a compare URL
  instead of opening the PR.
- At least one engine, installed and signed in: `agy`, `claude`, `codex` or `gemini`. Install
  commands for each are in
  [`docs/conductor/setup.md`](https://github.com/lktiep/cortex-hub/blob/master/docs/conductor/setup.md).
- A clone of the project the worker will work on.
- A worker API key from the dashboard (**API Keys**). Do not reuse the lead's key.
- Each engine needs a `cortex-hub` MCP entry with that key, so it can report progress. See
  [Multi-IDE](../guide/multi-ide#writing-the-entry-yourself).

## Install and start

Run this inside the clone:

::: code-group

```bash [macOS / Linux]
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.sh \
  | CORTEX_API_KEY=<worker-api-key> bash -s -- start --daemon --hub https://<your-mcp-host>
```

```powershell [Windows]
$env:CORTEX_API_KEY="<worker-api-key>"
iwr -useb https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.ps1 -OutFile $env:TEMP\run-agent.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\run-agent.ps1 start --daemon --hub https://<your-mcp-host>
```

:::

The dashboard's **Settings** page has this command with your hub's address filled in, under
**Run a worker**.

The bootstrap script:

1. downloads `cortex-worker.mjs` from your hub to `~/.cortex/worker/`;
2. installs `cw` to `~/.local/bin/cw` (Windows: `%USERPROFILE%\.local\bin\cw.cmd`) and adds that
   folder to your PATH through `~/.zshrc`, `~/.bashrc` or `~/.profile` (Windows: the user PATH).
   `CORTEX_SKIP_CW=1` skips this;
3. runs `cw check --if-changed` (skip with `CORTEX_SKIP_CHECK=1`);
4. runs the command you passed, here `start --daemon`.

Without `cw` on your PATH, the same commands work as `node ~/.cortex/worker/cortex-worker.mjs <command>`.

## Day to day

```bash
cw ls                # agents on this machine, numbered
cw status 1          # running state, task, last registration
cw tail 1 -f         # what the engine is printing on the current task
cw logs 1 -f         # the worker's own log
cw restart 1         # background, with the settings it last started with
cw stop --all
cw update            # replace cortex-worker.mjs with the hub's version
cw doctor --probe    # check the setup and run each engine once
```

`[agent]` is a name or its number in `cw ls`. Left out, `stop`, `logs`, `tail` and `restart` use
this repo's agent, or the only agent on the machine, and ask when there are several.

## Will it run my project? `cw check`

`cw check` lists what the machine lacks for this repo and offers to install it, then trial-runs
the project's setup and test commands in a temporary worktree of `origin/HEAD` (20 minutes per
step). It exits 0 when the machine is ready.

It reads requirements from:

- git (always) and `gh` (a warning only);
- `engines.node` in `package.json`, `.nvmrc` or `.node-version`;
- `packageManager` or the lockfile;
- tools the repo's git hooks call;
- the `worker` section of `.cortex/project-profile.json`;
- the engines you asked for.

Missing tools are installed with winget, Homebrew or `npm -g`. On Linux it uses npm only and never
runs sudo. In the output, `✓` is fine, `✗` blocks tasks and `!` is a warning.

### The `worker` section

```json
{
  "worker": {
    "setupCommand": "pnpm install --frozen-lockfile",
    "testCommand": "pnpm test",
    "requires": ["docker"]
  }
}
```

`CORTEX_SETUP_CMD` and `CORTEX_TEST_CMD` override the two commands on one machine.

A running worker repeats the readiness check every minute. Until it passes, `cw ls` shows the
agent as `not ready` and the worker declines the tasks it is offered as busy, so the hub gives them
to another machine. `CORTEX_SKIP_READINESS=1` turns the check off.

## What a worker does with a task

1. Makes a git worktree under `~/.cortex/worker/<agentId>/wt/` on the task's branch
   (`cx/{key}-{slug}` by default), from `origin/<base branch>`.
2. Runs the setup command: the task's own, else this machine's (`CORTEX_SETUP_CMD`), else the
   project's. Then runs the engine with the task's description, past reviews and any handoff.
3. Runs the test command.
4. Commits `<key>: <title>`, pushes, and opens a PR with `gh`, or reports a compare URL.
5. Reports the task for review with the PR link and test output.

If the engine runs out of quota, the worker pushes the work in progress, tells the hub when the
quota resets, and the hub sends the task to the next route in its fallback chain, on this machine
or another. When a task is revoked (cancelled, rerouted or reclaimed), the worker stops the
engine, pushes what it has and removes the worktree.

## Where things are

Everything for one agent is in `~/.cortex/worker/<agentId>/` (`CORTEX_WORKER_HOME` moves the
parent folder):

| File | What |
|---|---|
| `worker.pid`, `worker.log` | The running process and its log |
| `state.json` | Current state |
| `start.json` | The settings `cw restart` reuses (mode 600). The key is stored only if it came from `--api-key` or `CORTEX_API_KEY` |
| `wt/` | Worktrees |
| `tasks/<taskId>.log` | Engine output per task: the newest 10, up to 10 MB each |

## When it will not connect

| Close code | Meaning |
|---|---|
| 4001 | No API key |
| 4003 | The key is wrong, or not allowed for this project |
| 4000 | A newer connection with the same agent id replaced this one |
| 4009 | Another machine is already using this agent id |

A refusal that retrying cannot fix makes the worker exit with code 2. `cw doctor` checks each step
in order: node, git, gh, each engine, the hub config and health, the worker version, the
handshake, the git origin and the project mapping, and the engines' MCP configs.
