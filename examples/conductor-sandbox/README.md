# Conductor sandbox

A toy Node project and a plan of eleven harmless tasks, for testing Conductor end to end without
touching real code. Each task changes a few lines. Together they exercise routing by engine and by
capability, a fallback, a file lock, a run with no change, a user gate and a lead gate.
`plan-escalation.json` adds one task that always fails, to see an escalation.

Needs Node.js 20 or newer, git and the GitHub CLI (`gh`).

## What each task tests

| Key | Task | Tests |
|---|---|---|
| SBX | Conductor sandbox drill | The root group: done when everything below is done |
| P1 | Phase 1 | A group whose tasks run in parallel |
| A1 | Add clamp() | Routing to the `claude` engine, priority `high` |
| A2 | Add titleCase() | Routing to `agy` with no fallback: it waits for an agy worker |
| A3 | Note phase 1 in CHANGELOG.md | Routing by capability (`design`) to `sbx-claude`, after A1 and A2 |
| G1 | Sign off phase 1 | A gate only you can open, on the dashboard |
| P2 | Phase 2 | A group that waits for G1 |
| B1 | Add formatBytes() | `agy` first, `claude` as fallback |
| B2 | Add formatDuration() | Any agent. Shares `src/format.js` with B1, so the two run one at a time |
| B3 | Check the README usage examples | A run that changes nothing (`allowEmpty`) still completes |
| G2 | Lead sign-off | A gate the lead closes |
| E1 | Write NOTES.md | In `plan-escalation.json`: its test always fails, so it is retried, then escalated |

Every work task runs `node --test` as its check. Check a plan before sending it:

```bash
npm run check-plan
```

## 1. Make your own copy

Workers open pull requests, so the sandbox needs a repo of its own on GitHub.

macOS and Ubuntu:

```bash
git clone --depth 1 https://github.com/lktiep/cortex-hub.git /tmp/cortex-hub-src
mkdir -p ~/conductor-sandbox
cp -R /tmp/cortex-hub-src/examples/conductor-sandbox/. ~/conductor-sandbox
cd ~/conductor-sandbox
git init -b main && git add -A && git commit -m "Conductor sandbox"
gh repo create <you>/conductor-sandbox --private --source . --push
npm test
```

Windows (PowerShell):

```powershell
git clone --depth 1 https://github.com/lktiep/cortex-hub.git $env:TEMP\cortex-hub-src
New-Item -ItemType Directory -Force $HOME\conductor-sandbox | Out-Null
Copy-Item -Recurse -Force $env:TEMP\cortex-hub-src\examples\conductor-sandbox\* $HOME\conductor-sandbox
cd $HOME\conductor-sandbox
git init -b main; git add -A; git commit -m "Conductor sandbox"
gh repo create <you>/conductor-sandbox --private --source . --push
npm test
```

`npm test` should report 8 passing tests. Both copy the folder's contents, so running them again
over an existing `conductor-sandbox` does not nest a second one inside it.

## 2. Set up the lead

On the lead's machine, add the hub to Claude Code with the **lead** key (the snippet in
[setup.md, section 5](../../docs/conductor/setup.md#5-point-each-engine-at-the-hub)). If Claude Code
already has a `cortex-hub` entry with another key, run `claude mcp remove --scope user cortex-hub`
first.

```bash
claude mcp add --transport http --scope user cortex-hub https://<your-mcp-host>/mcp \
  --header "Authorization: Bearer <lead-api-key>"
```

Then install Cortex in your copy. Run it inside the folder.

macOS and Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.sh | bash
```

Windows (PowerShell, with Python 3 installed):

```powershell
iwr -useb https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/install.ps1 -OutFile $env:TEMP\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\install.ps1
```

Windows refuses to run a downloaded script directly ("running scripts is disabled on this
system"). `-ExecutionPolicy Bypass` allows this one run and leaves the machine's policy as it is.

The installer adds the session hooks and the `/cs` and `/ce` commands under `.claude/`, plus
`CLAUDE.md` and `.cortex/`, and lists `.claude/` in `.gitignore`. Leave all of it uncommitted:
the workers start from the GitHub repo and need none of it.

Start Claude Code in the folder (or run `/mcp` and reconnect `cortex-hub` in a session that was
already open) and run `/cs`. The lead needs `cortex_task_tree_create` and `cortex_agents`. If it
says it does not have them, the lead key does not grant them: edit the key on the dashboard's API
keys page, tick every box, save, and reconnect.

## 3. Start the agents

Give each agent its own worker key (Dashboard, API keys). Run these inside your copy. They are
the commands from [setup.md](../../docs/conductor/setup.md#6-install-a-worker) with a name and an
engine added.

macOS and Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.sh | CORTEX_API_KEY=<worker-key-1> bash -s -- start --daemon --hub https://<your-mcp-host> --agent-id sbx-claude --engines claude --capabilities design
curl -fsSL https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.sh | CORTEX_API_KEY=<worker-key-2> bash -s -- start --daemon --hub https://<your-mcp-host> --agent-id sbx-agy --engines agy
```

Windows:

```powershell
iwr -useb https://raw.githubusercontent.com/lktiep/cortex-hub/master/scripts/run-agent.ps1 -OutFile $env:TEMP\run-agent.ps1
$env:CORTEX_API_KEY="<worker-key-1>"; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\run-agent.ps1 start --daemon --hub https://<your-mcp-host> --agent-id sbx-claude --engines claude --capabilities design
$env:CORTEX_API_KEY="<worker-key-2>"; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\run-agent.ps1 start --daemon --hub https://<your-mcp-host> --agent-id sbx-agy --engines agy
```

`sbx-claude` is the only agent with the capability `design`, so A3 goes to it. Leave IDE windows
out of this drill. A window with the Cortex extension
([antigravity.md](../../docs/conductor/antigravity.md)) is given loose tasks only, never a plan's:
it cannot tell for sure when its agent has finished.

Check: `node ~/.cortex/worker/cortex-worker.mjs status --agent-id sbx-claude` (and `sbx-agy`), and
the two agents on the dashboard's Conductor page.

## 4. Load the plan

**With a lead (recommended).** In the Claude Code session from step 2, paste the prompt in
[LEAD-PROMPT.md](LEAD-PROMPT.md). The lead creates
the whole tree in one call, reviews and merges each PR, and reports progress.

**Without a lead.** On the hub machine, with the project id the lead would use (from
`cortex_session_start` in your copy, or the dashboard's Projects page):

```bash
node scripts/check-plan.mjs --body <projectId> plan.json > body.json
curl -sS -X POST http://localhost:4000/api/conductor/tree -H 'Content-Type: application/json' --data @body.json
```

Then approve each task's review on the Conductor page yourself. Always pass the project id: a task
without one can go to a worker in any of your repos.

## 5. What should happen

1. A1 goes to `sbx-claude` and A2 to `sbx-agy`, at the same time. A3 waits for both.
2. Each opens a PR on a `cx/<key>-…` branch with a commit titled `<key>: <title>`. The lead merges it
   and approves the task.
3. A3 goes to `sbx-claude`, the only agent with `design`, even when `sbx-agy` is free.
4. P1 completes. G1 shows under "Needs you" on the dashboard. Nothing else moves until you approve it.
5. B1, B2 and B3 become ready together. B1 and B2 both change `src/format.js`, so they run one at a
   time: whichever is dispatched first holds the file, and the other waits until it is done, then
   starts from the merged code. Either order is right. B1 runs on `sbx-agy` when it can. If
   `sbx-agy` is stopped, or agy fails B1, B1 moves to `sbx-claude`, its fallback.
6. B3 finds nothing to correct and completes with no PR.
7. The lead pulls, runs `npm test` and approves G2. SBX completes.

After a full run, `npm test` on `main` reports at least 12 passing tests.

`sbx-agy` runs agy in `accept-edits` mode: agy edits files but runs no commands, and the worker
runs `node --test` itself. A task that fails with `agy stopped early: …` names the permission agy
was refused; see [What agy may do on its own](../../docs/conductor/antigravity.md#what-agy-may-do-on-its-own).

## 6. Escalation drill

Load `plan-escalation.json` the same way. E1's check is `node -e "process.exit(1)"`, so every run
fails. The worker still commits NOTES.md and opens a PR, then reports the run as failed. The task
is retried once on the same branch, then escalated to the lead, who sees it in "Needs you" and
cancels it with `cortex_task_cancel` (or cancel it on the dashboard). Close the PR without merging.

## 7. Stop it, run it again

To stop a plan midway, the lead cancels its root group: `cortex_task_cancel` on SBX. Every
unfinished task under it is cancelled, and the ones running are stopped. Close their PRs without
merging.

Keys are unique within a tree, not across trees, so the same plan can be loaded again as a new
tree. Reset the code first:

```bash
git checkout main && git pull
git reset --hard <first commit> && git push --force-with-lease origin main
```

Or delete the GitHub repo and repeat steps 1 and 2.

## Usage

```js
import { sum, mean } from './src/math.js'
import { slugify } from './src/strings.js'
import { pad2, groupDigits } from './src/format.js'

console.log(sum([1, 2, 3]))           // 6
console.log(mean([2, 4, 9]))          // 5
console.log(slugify('Hello, World!')) // hello-world
console.log(pad2(7))                  // 07
console.log(groupDigits(1234567))     // 1,234,567
```

To run it (macOS and Ubuntu): `sed -n '/^```js$/,/^```$/p' README.md | sed '1d;$d' | node --input-type=module`
