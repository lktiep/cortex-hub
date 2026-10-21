# Hooks

The [installer](./installer) puts eight Claude Code hooks in `.claude/hooks/` and wires them up in
`.claude/settings.json`. They hold the agent to the Cortex workflow: open a session, recall, find
code, pass the gates, then commit. They are shell scripts; a few carry JavaScript inside and need
`node`. `run-hook.mjs` sits next to them and runs a hook's `.sh` or `.ps1`, whichever fits the
platform.

| Hook | Version | Event and matcher | Blocks? |
|---|---|---|---|
| `session-init.sh` | v7.3 | `SessionStart` | No; resets the markers |
| `subagent-start.sh` | v1.0 | `SubagentStart` | No; adds context |
| `enforce-session.sh` | v6.2 | `PreToolUse`: `Edit\|Write\|NotebookEdit\|Bash` | Yes |
| `enforce-commit.sh` | v5.1 | `PreToolUse`: `Bash` | Yes |
| `nudge-lookup.sh` | v1 | `PreToolUse`: `Bash\|Grep\|Glob` and the cortex code tools | No; a one-line hint |
| `recall-notes.sh` | v1 | `PreToolUse`: `Read\|Edit\|Write\|MultiEdit\|NotebookEdit` | No; shows file notes |
| `track-quality.sh` | v4.3 | `PostToolUse`, every tool | No; records evidence |
| `session-end-check.sh` | v7.1 | `SessionEnd`, 15 s timeout | No; closes the session |

A blocking hook exits with code 2 and a message that starts with `BLOCKED:`. Claude Code shows that
message to the agent, which then knows what to run.

## Markers

The hooks share state through files in `.cortex/.session-state/`. `track-quality.sh` writes them
after a tool call; the blocking hooks read them. A marker counts only if it holds a
`tool=<name> at=<time>` line, so creating an empty file does not open a gate.

| Marker | Written after |
|---|---|
| `session-started`, `session-id` | `cortex_session_start` (the id is the hub's `sess_…`) |
| `knowledge-recalled`, `memory-recalled` | `cortex_knowledge_search`, `cortex_memory_search` |
| `discovery-used` | `cortex_code_search`, `cortex_code_context`, `cortex_code_impact`, `cortex_cypher` |
| `gate-build`, `gate-typecheck`, `gate-lint` | `pnpm\|npm\|yarn build`/`typecheck`/`lint`, `cargo build`, `cargo clippy`, `go build`, `go vet`, `dotnet build`, when the output shows no failure |
| `quality-gates-passed` | All three gates; or build and lint when the project profile has no typecheck |
| `quality-reported` | `cortex_quality_report` |
| `tasks-checked`, `changes-checked` | `cortex_task_pickup`; `cortex_detect_changes` or `cortex_changes` |
| `session-ended` | `cortex_session_end` |
| `agents/<agent_id>/…` | A subagent's own knowledge and memory recall |

Knowledge and memory searches are recall, not discovery: `/cs` alone does not count as finding code.

A gate command whose output contains `ERR_PNPM`, `ELIFECYCLE`, `error TS<n>`, `Command failed`,
`FAIL `, `Exit status <n>` or an ESLint `✖ N problems (N errors…` with errors above zero does not
arm its marker, even if the command exited 0.

## `session-init.sh`

Runs on every `SessionStart`. On a new session (startup or `/clear`) it removes every marker from
the last one, so nothing stays satisfied for longer than a conversation, and prints the reminder to
run `/cs`. On `compact` and `resume` it keeps the markers: a long task does not find itself blocked
again halfway through because its context was compacted. Either way it prints this conversation's
`clientSessionId` for `/cs` to pass to `cortex_session_start`.

It also drops conversation records older than a week and nudge or file-note records older than a
day.

## `subagent-start.sh`

When a session is open and the gates are not off, it gives each subagent a short brief: the
parent's recall is not in your context, run `cortex_knowledge_search` and `cortex_memory_search`
for your own task before editing, use `cortex_code_context` or `cortex_code_search` to find code,
search knowledge for an error before fixing it. See [Subagents](../guide/subagents).

## `enforce-session.sh`

Before `cortex_session_start`:

- `Edit`, `Write` and `NotebookEdit` are refused.
- A Bash command that writes a file is refused: a redirect into a file (`>`, `>>`), `sed -i`,
  `tee`, `dd`, `truncate`, `install -`, and `git add|commit|push|reset`, `rm`, `mv`, `cp`, `mkdir`,
  `touch`, `chmod`. Redirects to `/dev/*` and `>&2` are not writes.
- A Bash command that starts with `grep`, `egrep`, `fgrep`, `rg`, `ag`, `ack`, `find`, `fd` or
  `git grep` is refused. After a pipe it is allowed: `pnpm build | grep error` filters output, it
  does not search code.
- Plain reads pass: `ls`, `cat`, `head`, `tail`, `git status|log|diff|show`, package-manager
  commands and so on.

After `cortex_session_start`:

- Until a discovery call has run, a Bash command that starts a code search is refused.
- Every file write, with a tool or through Bash, needs both `knowledge-recalled` and
  `memory-recalled`. This applies for the whole session; a discovery call does not lift it.
- A subagent (a call that carries an `agent_id`) needs its own recall markers under
  `agents/<agent_id>/`; the parent's do not count.

::: info
The script also has branches that refuse the `Grep` and `Glob` tools. Its matcher in
`settings.json` does not include those tools, so the branches do not run; in Claude Code only Bash
searches are held back.
:::

## `enforce-commit.sh`

For every Bash command, it first refuses anything that skips the repo's own git hooks:
`--no-verify` (or any prefix of it, such as `--no-veri`), `git commit -n`, and `LEFTHOOK=0` or
`LEFTHOOK=false`. Text inside quotes and heredocs is ignored, so a commit message that mentions the
flag is fine. `git push -n` is a dry run and stays allowed.

For a command that starts with `git commit`, it needs:

- `session-started`;
- `discovery-used`;
- `quality-gates-passed`.

Calling `cortex_quality_report` does not stand in for the gates. Without a report the commit still
goes through, with a reminder. After `git push` it reminds the agent to run `cortex_code_reindex`.

### A green build certifies the tree

Any write after the gates pass clears `quality-gates-passed` and the three `gate-*` markers: an
`Edit`, `Write` or `NotebookEdit`, or a Bash command that redirects into a file or runs `sed -i`,
`tee`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `patch` or `git apply`. A gate command that writes its
own log (`pnpm build | tee build.log`) does not clear the marker it just set. Run the gates last,
then commit.

## `nudge-lookup.sh`

Never blocks. When a repo-wide grep looks for a symbol or a word, it adds one line naming the
cortex call that would answer it, at most once every few searches per agent. It stays quiet for
literals (env vars, config keys, error strings), for searches inside known files or outside the
repo, for file-name searches, and right after a cortex lookup. `CORTEX_NUDGE=off` turns it off.
Without `node` it does nothing.

## `recall-notes.sh`

Never blocks. Before an agent reads or edits a file, it shows the risks, lessons and fixes that
were stored with `cortex_knowledge_store(files: [...])` for that path. It asks the hub once for
the whole project (`cortex_file_notes`) and caches the answer for 10 minutes; a hub that does not
answer is asked again after 2 minutes, and meanwhile the hook stays quiet. It shows up to three
notes per file, once per conversation and agent. `CORTEX_NOTES=off` turns it off. Without `node`
it does nothing. See [File notes](../guide/knowledge-memory#file-notes).

## `track-quality.sh`

Runs after every tool call and writes the markers above. It also files the hub session id under
the conversation that opened it (`conversations/<clientSessionId>`), so the exit hook closes the
right one when several conversations share a checkout.

## `session-end-check.sh`

When the Claude Code session ends and `/ce` did not close the hub session, it closes it with
`auto: true`. The hub records it as `abandoned` and keeps it out of what later sessions recall. It
finds the hub the way the agent does: `CORTEX_MCP_URL` or `HUB_MCP_URL` together with
`HUB_API_KEY`, else the `cortex-hub` entry in the project's or the machine's MCP configs. It needs
`python3`. `settings.json` gives it 15 seconds.

## `gate-off`: when the hub is down

If the hub cannot be reached, the gates have no way through. Say so, then write the reason:

```bash
echo 'hub unreachable' > .cortex/.session-state/gate-off
```

Writing this file is never blocked. While it exists, `enforce-session.sh` lets everything through,
and the subagent brief, the lookup nudge and file notes stay quiet. The commit gate still applies.
The next new session removes the file.

## Switches

| Variable | Effect |
|---|---|
| `CORTEX_NUDGE=off` | Turns off `nudge-lookup.sh` |
| `CORTEX_NOTES=off` | Turns off `recall-notes.sh` |
| `CORTEX_MCP_URL` or `HUB_MCP_URL`, with `HUB_API_KEY` | Hub address and key for `session-end-check.sh` and `recall-notes.sh`. Without them they use the `cortex-hub` MCP entry |

## Gemini and Antigravity

The installer puts five of these in `.gemini/hooks/`: session-init, enforce-session,
enforce-commit, track-quality and session-end-check.

## Testing the hooks

`scripts/test-hooks.sh` feeds each hook the payloads that once got through a shipped version.
A failure there means a gap is back.
