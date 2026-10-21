# Slash commands and skills

Cortex Hub ships three Claude Code commands. `/cs` and `/ce` are written into each project by the
[installer](./installer); `/install` is a global skill. The cortex-bar mod adds two more, listed
in [Mods](./mods).

| Command | Where it lives | What it does |
|---|---|---|
| `/cs` | `.claude/commands/cs.md` | Opens a session and recalls context |
| `/ce` | `.claude/commands/ce.md` | Runs the gates, stores what was learned, closes the session |
| `/install` | `~/.claude/skills/install/SKILL.md` | Runs the installer in the current project |
| `/cortex-bar`, `/cortex-calls` | cortex-bar mod | Status bar and call pane; see [Mods](./mods) |

## `/cs`: start a session

1. `cortex_session_start(repo, mode, agentId, ide, branch, clientSessionId)`. Keeps `session_id`,
   the project id and `project.orgId`.
2. `cortex_knowledge_search` and `cortex_memory_search`, in parallel.
3. `cortex_changes`: unseen commits and files from other agents.
4. `cortex_task_pickup`: Conductor tasks for this agent, if any.
5. `git status`; on a dirty tree, `cortex_detect_changes` with `git diff HEAD`.
6. A situational summary.
7. The workflow for the rest of the session:
   - score non-trivial plans with `cortex_plan_quality` (8.0 to pass, up to three tries);
   - find code with the [lookup table](../guide/code-intelligence#pick-the-tool-by-what-you-already-know),
     search once and read all ten hits;
   - search knowledge and memory on an error before fixing it;
   - `cortex_detect_changes` before a commit, `cortex_code_reindex` after a push;
   - for a Conductor task: accept, set `in_progress`, then complete it.

In Claude Code the hooks block edits until steps 1 and 2 have run.

::: info
Step 1 of `/cs` warns and runs `git pull` when the start response reports `recentChanges`. The
current `cortex_session_start` does not return that field, so this branch does not fire;
`cortex_changes` in step 3 covers the same ground.
:::

## `/ce`: end a session

1. `cortex_detect_changes` on the diff; warns when risk is HIGH.
2. `pnpm build && pnpm typecheck && pnpm lint`.
3. `cortex_quality_report(gate_name: "Session Quality", ...)`.
4. Completes any Conductor task still in progress.
5. `cortex_knowledge_store`, when there is something the team should know.
6. `cortex_memory_store` with what was done, decisions and next steps.
7. `cortex_session_end(sessionId, summary)`. The hub saves the summary as memory.
8. A final report.

## `/install`

```
/install                       # set up this project
/install --check               # report what is installed
/install --force               # regenerate everything
/install --tools claude,gemini # only these IDEs
```

The skill downloads `scripts/install.sh` through the GitHub API, falling back to
`raw.githubusercontent.com`, and runs it. It has `disable-model-invocation: true`, so Claude runs
it only when you type it. Its source is `templates/skills/install/SKILL.md`.

## In other IDEs

Cursor, Windsurf, VS Code Copilot and Codex have no slash commands from Cortex. Their rules files
tell the agent to run the same steps through the MCP tools. See [Multi-IDE](../guide/multi-ide).
