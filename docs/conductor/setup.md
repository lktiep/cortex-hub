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
- What the project itself needs: its package manager, and the tools its git hooks call, such as
  docker or python3. `cw check` (section 7) lists them and offers to install them.

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
- **agy runs with `--mode accept-edits` everywhere.** It may edit files but not run commands, since
  headless agy cannot ask and a refused command ends its run. Windows and some accounts have no
  `--mode auto`. See [Antigravity: what agy may do on its own](antigravity.md#what-agy-may-do-on-its-own)
  for `CORTEX_AGY_MODE`, allow-rules and the opt-in `CORTEX_AGY_SKIP_PERMISSIONS=1`.
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

Antigravity 2.x (the app, and the agy that ships with it) reads `~/.gemini/config/mcp_config.json`
instead, and also takes the vendor's direct form with `serverUrl` and `headers`, without
`mcp-remote`. On some Macs the `antigravity/` file is a symlink to it. The worker and the extension
read both paths and both forms. See [antigravity.md](antigravity.md) for the app, the IDE and a
headless agy with its own key.

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
> This reads `~/.gemini/antigravity/mcp_config.json`. If it reports no entry, replace
> `antigravity` with `config` in the path to read the Antigravity 2.x file.

The worker takes the hub URL from `--hub`, then `CORTEX_HUB_URL`, then the first `cortex-hub` entry
it finds in `~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/antigravity/mcp_config.json`,
`~/.gemini/config/mcp_config.json` and `~/.cursor/mcp.json`, in that order. The key comes from `--api-key`, then `CORTEX_API_KEY`,
then the entry for the same hub in those files.

#### VS Code extension

Install it into Antigravity IDE, VS Code, Cursor and Windsurf from the latest release:

```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install-extension.ps1 | iex
```

The VSIX itself is at
`https://github.com/lktiep/cortex-hub/releases/latest/download/cortex-agent.vsix`. Each window can
have its own agent name and key, set with the pencil in the Agent Panel; the key goes to the OS
keychain. See [antigravity.md](antigravity.md#2-antigravity-ide-one-agent-per-window).

The Cortex extension finds the hub in this order: the `cortexHub.hubUrl` setting (empty by
default), then the `CORTEX_HUB_WS_URL` or `CORTEX_HUB_URL` env var, then the MCP config it
detects (Claude Code, `.mcp.json`, Gemini, Antigravity, Cursor, Windsurf, VS Code). It does not
read `~/.codex/config.toml`. At activation it logs `hubSource` (`setting`, `env:<NAME>`, a config
path or `default`) so you can see which one won. The key appears only as `***` plus its last 8
characters.

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

Or copy these from Dashboard, Settings, "Run a worker". It fills in your hub from
`EXTERNAL_MCP_URL`. Without it, the dashboard uses the https address an agent last connected
through (see below), or the address you opened the dashboard on when that is localhost or a LAN
address.

**How the dashboard learns the MCP address.** Behind a domain, the dashboard and MCP sit on
different hostnames, so the dashboard cannot work out one from the other. The MCP gateway can:
each time it checks an agent's key, it passes on the https host the agent dialled, as the tunnel
forwarded it (`X-Forwarded-Proto: https` and `Host`). The hub keeps the last one and the dashboard
shows it with "Seen on `<agent>`'s connection". Only an https domain is kept: localhost, LAN
addresses and plain http never are. `EXTERNAL_MCP_URL` always wins, and pins the address. To drop
a detected address, set `EXTERNAL_MCP_URL`, or delete the `mcp.detected` row of the `hub_config`
table.

Anyone holding a valid key and reaching port 8318 directly could send a made-up `Host` and change
what the dashboard shows. It never changes who can connect. If that matters to you, set
`EXTERNAL_MCP_URL`.

Options (add them after `start`):

| Flag | Meaning |
|---|---|
| `--agent-id <id>` | Worker name (`cw start <id>` is the same). Default: `CORTEX_AGENT_ID`, else `<host>-<repo folder>`. Use a different one for each worker on a machine. |
| `--repo <path>` | The clone to work in. Default: the current directory. |
| `--engines claude,agy` | Engines to look for, in order. Default: `agy,claude,codex,gemini`. |
| `--capabilities a,b` | Tags the hub can match tasks on. Use ids from the hub's `.cortex/capability-templates.json` (`plan, orchestrate, backend, frontend, design, review, godot, resources, game-logic, server, build-game, database, devops, security, testing, docker, deploy`). Unknown tags are dropped, with a warning on the hub. |
| `--engine-timeout <min>` | Minutes an engine may run per task. Default: 90. The setup and test commands, and the commit and push with the project's own git hooks, get the same limit. Saving unfinished work (a WIP commit and push) gets 10 minutes (section 10). |
| `--hub <url>`, `--api-key <key>` | Override the detected hub and key. |

Before it starts the worker, the bootstrap runs `cw check --if-changed` on the same repo
(section 7): one list of what this machine lacks, one question before it installs anything, then
a trial run of the project's setup and test commands. It never stops the start: a worker on a
machine that is not ready takes no tasks until it is (section 8). Under `curl | bash` it asks on
the terminal; with no terminal to ask in, it installs nothing. `CORTEX_SKIP_CHECK=1` skips it.

The bootstrap also installs the `cw` command, short for cortex-worker: `~/.local/bin/cw` on
macOS and Linux, `%USERPROFILE%\.local\bin\cw.cmd` on Windows. When that folder is not on your
PATH yet, it adds it: one line at the end of `~/.zshrc`, `~/.bashrc` or `~/.profile` (by your
shell), or your user PATH on Windows. Open a new terminal to use `cw`. A `cw` that is not the
Cortex one is left as it is, and `CORTEX_SKIP_CW=1` skips all of this.

Without `cw`, call the worker with node, which takes the same commands:

- macOS and Linux: `node ~/.cortex/worker/cortex-worker.mjs <command>`
- Windows: `node $HOME\.cortex\worker\cortex-worker.mjs <command>`

You can also re-run the bootstrap with the command, for example `... bash -s -- doctor --hub ...`.

State, the pid file and the log live in `~/.cortex/worker/<agentId>/`. Task worktrees are under
`~/.cortex/worker/<agentId>/wt/`.

## 7. Check it

Run this inside the clone:

```bash
cw doctor
```

Add `--probe` to also send a
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
| `worker version` (optional) | Same version as the hub serves | `cw update`, then `cw restart --all`. |
| `handshake` | The hub accepts the key and sends its welcome | Check the key in `--api-key`, `CORTEX_API_KEY` or the MCP config. `closed 4001` or `closed 4003` (or a 401 from a proxy) means a rejected key; see section 10. |
| `origin` | The repo has a remote named `origin` | Run doctor inside a clone, or pass `--repo <path>`. |
| `project mapping` (optional) | Shows the project the hub mapped this repo to | Reads "unknown until first start" before the worker has connected once. |
| `engine MCP configs` (optional) | No engine's MCP entry points at a different hub | Edit the file it names so the `cortex-hub` URL is the worker's hub. |

The key is validated by the `handshake` row. There is no separate key row.

### What the project needs: `cw check`

`doctor` checks the worker. `cw check` checks the project: can this machine do its tasks?

```bash
cw check             # the repo of the current folder
cw check 2           # agent 2's repo, engines, and setup and test commands
cw check --yes       # install what is missing without asking (or -y)
```

It works out what the project needs from its own files:

| Where | What it needs |
|---|---|
| always | git, and gh as a warning |
| `package.json` `engines.node` | that Node; without it, Node 20 or newer |
| `.nvmrc` or `.node-version` | that Node major, as a warning |
| `packageManager` (like `pnpm@9.12.0`), else the lockfile | pnpm, yarn or bun, the same major |
| the git hooks: lefthook files, `.husky/`, `.githooks/`, the package scripts they run and the files those run | docker or python3, when they call it |
| `worker.requires` in the project's profile (below) | each command listed, in place of the hook scan |
| `--engines`, or the agent's own | one of those engines |

It prints one list. `✓` is what it found, `✗` stops tasks, `!` is a warning, and each has a fix:

```
cw check: /src/acme

✓ git 2.47.1, node 22.12.0, engines: claude
✗ pnpm — not found; package.json packageManager is pnpm@9.12.0
    fix: npm install -g pnpm@9.12.0
! gh — not found; opens the pull requests (without it a task ends with a compare link)
    fix: brew install gh

cw check can do these for you:
  brew install gh
  npm install -g pnpm@9.12.0
Go ahead? [Y/n]
```

**Installing.** It asks once, and Enter means yes. It uses winget on Windows, Homebrew on macOS,
and `npm install -g` for pnpm, yarn, bun and the claude, codex and gemini CLIs. On Linux it
installs only through npm and prints the command for the rest; it never runs sudo. Some fixes stay
yours: a Node on the wrong version, a Docker that is installed but not running, `gh auth login`. When a new tool is not on
this terminal's PATH yet, it says so: open a new terminal and run `cw check` again.

**Python on Windows.** Hooks often call `python3`, but Python from python.org or winget has only
`python` and `py`. When Python is installed, `cw check --yes` adds `python3.cmd` (for cmd and
PowerShell) and `python3` (for the sh that git hooks run in) to `%USERPROFILE%\.local\bin`, next
to `cw`. Both run that python.exe. A `python3` there that `cw check` did not write is left alone.
When `python3` opens the Microsoft Store, turn off the python.exe and python3.exe aliases in
Settings → Apps → Advanced app settings → App execution aliases.

**The trial run.** Once no `✗` is left, it runs the project's setup and test commands once, as a
task runs them, in a temporary worktree of the branch tasks start from (`origin/HEAD`). The
worktree is removed afterwards. A step that fails shows its last 40 lines; tasks would fail the
same way. Each step may run for 20 minutes. The hub key is kept out of these commands and out of
the installers.

```
trial run: the setup and test commands, as a task runs them, in a temporary worktree
✓ setup: pnpm install --frozen-lockfile
✓ test: pnpm test
ready: this machine can take tasks for /src/acme
```

The exit code is 0 when the machine is ready, and 1 when it is not. `--if-changed` skips the trial
when it passed before and nothing it rests on has changed: the branch's `package.json`, lockfiles,
`.nvmrc`, `.node-version`, profile and hook files, and this machine's `CORTEX_SETUP_CMD` and
`CORTEX_TEST_CMD`.

### Project settings: the `worker` section

What the files cannot show goes in the project's own `.cortex/project-profile.json`, committed to
the branch tasks start from:

```json
{
  "worker": {
    "setupCommand": "pnpm install --frozen-lockfile",
    "testCommand": "pnpm test",
    "requires": ["docker", "python3"]
  }
}
```

| Key | Meaning | Without it |
|---|---|---|
| `setupCommand` | Runs in each task's new worktree, before the engine. `""` turns it off. | The lockfile's install: `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `bun install --frozen-lockfile` or `npm ci`. No lockfile, no install. |
| `testCommand` | The engine is told to run it. The worker runs it again after the engine, and puts its output in the pull request. | None. |
| `requires` | Commands the project needs that its files do not show. It replaces the hook scan; `cw check` notes a tool a hook calls that the list leaves out. | What the hooks call. |

A task uses the first of: the setup or test command the task itself carries, this machine's
`CORTEX_SETUP_CMD` or `CORTEX_TEST_CMD`, then the profile (and the lockfile, for setup).

## 8. Run as a daemon

```bash
cw start acme -d     # start agent "acme" in the background (inside its clone); output goes to the log
cw ls                # every agent on this machine, numbered
cw status 2          # agent 2 of that list: running? task? last registration
cw logs 2 -f         # its last 200 lines, then follow (Ctrl+C to quit)
cw tail 2 -f         # what its engine prints on the current task, then follow
cw restart 2         # stop it, then start it again with the settings it last started with
cw stop 2            # waits for a running task to wrap up
cw stop --all        # every running agent
cw restart --all     # every agent, running or not
cw update            # fetch the hub's worker version
```

`cw ls` prints a table like this:

```
#  AGENT   STATE                         TASK  ENGINES  REPO
1  acme    running (pid 812)             -     claude   /src/acme
2  mini    stopped                       -     agy      /src/mini
3  studio  running (pid 905), not ready  -     claude   /src/studio
```

An agent is its name or its number in `cw ls`. The numbers go by name and count this machine
only, so they differ from the worker numbers on the dashboard, which count the online workers of
every machine. A number that is also an agent's name (an agent called `2`) means that agent.
`cw status` without an agent prints the list. `logs`, `stop` and `restart` without one take the
agent of the current folder, or the only agent there is, and otherwise ask which one.

**Following a task.** While a task runs, its page on the dashboard shows the step it is on (the
newest tool call, such as `Bash: pnpm test`, or worker step, such as `push`), when the engine last
printed something, and when the worker last checked in. Every few seconds the worker sends the
hub what the engine said: its text, thinking, tool calls and errors, each cut to one short line,
with keys and tokens replaced by `***` and the worktree path left out. With claude and agy, tool
output and stderr stay on the machine; codex and gemini print plain text on both, and each line
goes as text. When the engine prints a lot at once, the hub gets the newest lines and a count of
the rest. When it prints nothing for a minute, the worker sends
`still running: <step>, no output for N min`, once a minute. The hub keeps a task's newest 200
batches. When nothing at all comes for 3 minutes, the page says so: run `cw status` on that machine.

Everything the engine prints, tool output included, goes to
`~/.cortex/worker/<agentId>/tasks/<taskId>.log` on the worker's machine, keys replaced by `***`.
`cw tail <agent>` prints the last 40 lines of the newest one, and `-f` follows it, moving on to
the next task when one starts. Only you can read these files (mode 600; on Windows, your profile
folder's permissions). The worker keeps the newest 10 and stops writing one at 10 MB.

**When the machine is not ready.** Before each task, the worker looks for what `cw check` would
mark `✗` (not the trial run, which is too slow). When something is missing, it turns the task
down as busy, so the hub gives it to another worker or keeps it waiting, and the log says what is
missing:

```
machine not ready, so it takes no tasks: pnpm: not found; package.json packageManager is pnpm@9.12.0 (run cw check)
```

It looks again every minute. Once you fix it, the log says `machine ready: taking tasks again`
and the worker asks for work. Until then `cw ls` shows `not ready`, and `cw status` has a
`not ready:` line. A look that fails or takes over 30 seconds does not hold tasks up.
`CORTEX_SKIP_READINESS=1` on `start` turns this off.

**What `restart` reuses.** `start` saves the settings it ran with in
`~/.cortex/worker/<agentId>/start.json`: the repo, hub, engines, capabilities, engine timeout,
`CORTEX_SETUP_CMD`, `CORTEX_TEST_CMD`, `CORTEX_GH_BIN`, `CORTEX_SKIP_READINESS` and the `CORTEX_AGY_*` settings. It saves the key too when
you gave it with `--api-key` or `CORTEX_API_KEY`, so the file is readable by you only (mode 600;
on Windows, your profile folder's permissions). A key the worker read from an MCP config is not
saved, and `restart` reads it from there again. `cw ls` never shows the key. Delete the agent's
folder to forget it all. To change a setting, `cw stop` the agent and `cw start` it again with the
new value. An agent last started by an older worker has no `start.json`: start it once with
`cw start <name> -d`.

After `update`, run `cw restart --all` to use the new version.

The daemon does not survive a reboot. Nothing restarts it, so run `cw restart --all` after a
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
- A task runs long and you cannot tell why: open it on the dashboard for its current step, or run
  `cw tail <agent> -f` on its machine (section 8).
- `agy` is slow to start: see the notes in section 4.
- A task ran against the wrong hub: run `doctor` and read the `engine MCP configs` row.
- A worker takes no tasks and `cw ls` says `not ready`: run `cw check <agent>`, fix the `✗` items,
  and it takes tasks again within a minute (section 8).
- A hook fails with `python3: not found` on Windows: run `cw check --yes` (section 7).
- `cw check` passes but tasks fail in setup: the task may carry its own setup command, which the
  trial does not run. The task's error, `setup command failed (exit N)`, ends with the last lines
  the command printed.
- `git push failed (stopped after 90 min)`: the project's pre-push hook ran longer than the engine
  limit. Raise `--engine-timeout`, or make the hook faster. A failed commit or push shows what the
  hook printed.
- The log says `the WIP commit … was not pushed`: after a failure, a timeout or a quota handoff
  the worker commits the unfinished work and pushes it, hooks included, within 10 minutes. A
  pre-push hook that runs the full checks can take longer, more so with several workers testing
  at once. The commit is safe on the local branch, in the worktree the worker keeps. The worker
  sets `CORTEX_WIP_PUSH=1` for that push only, so the project's hook can skip its slow checks
  there:

  ```sh
  # in the pre-push hook, or the script it runs
  [ "$CORTEX_WIP_PUSH" = 1 ] && exit 0  # unfinished work from a Cortex worker
  ```

  The push that opens the pull request does not set it and runs every check. The worker never
  pushes with `--no-verify`: what a WIP push skips is the project's choice.

## 11. Security

- MCP configs hold API keys in plain text. Keep them private and do not paste them into chats,
  tickets or logs.
- A task's full transcript stays on the worker's machine. The hub gets short lines with keys
  replaced by `***`. That catches the usual key shapes, not every secret, so keep secrets out of
  task descriptions and out of what the engine prints.
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
