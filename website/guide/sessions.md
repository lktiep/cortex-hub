# Sessions and recall

A session is one stretch of work by one agent on one repo. The hub records it, hands the next
session what this one learned, and tells agents in the same repo about each other.

## Open a session: `/cs`

`/cs` is a slash command the installer puts in `.claude/commands/cs.md`. It runs seven steps:

1. **Start.** `cortex_session_start` with the repo, `mode`, `agentId`, IDE, branch and
   `clientSessionId`. The agent keeps the returned `session_id`, the project id and
   `project.orgId` for the rest of the conversation.
2. **Recall.** `cortex_knowledge_search` and `cortex_memory_search`, in parallel.
3. **Who else is here.** `cortex_changes` lists commits and files other agents pushed that this
   agent has not seen.
4. **Tasks.** `cortex_task_pickup` checks for Conductor tasks assigned to this agent.
5. **Your tree.** `git status`; if the tree is dirty, `cortex_detect_changes` with `git diff HEAD`.
6. **Summary.** A short situational report.
7. **Workflow.** The rules for the rest of the session: how to find code, what to do on an
   error, what to run before a commit.

In Claude Code, the hooks refuse every edit until steps 1 and 2 have run. See
[Hooks](../reference/hooks).

### What `cortex_session_start` returns

| Field | What it is |
|---|---|
| `session_id` | Pass it to `cortex_session_end` |
| `project.id`, `project.orgId` | The project the repo maps to, and its organization. Cross-repo search is limited to that organization |
| `mission_brief` | The project name and mode, plus the knowledge entry that best matches "session summary progress next session": usually the last session's summary |
| `recent_sessions`, `relevant_knowledge` | Recent sessions on the repo, and the top three knowledge hits |
| `auto_registered`, `project_note` | Set when the hub created the project on first sight of the repo |
| `hub_error` | Set when part of the start failed; the session still opens |

### `clientSessionId`

Claude Code's SessionStart hook prints the conversation's id as `clientSessionId`, and `/cs`
passes it on. A conversation that is compacted and resumed keeps the same id, so the hub keeps
one session instead of opening a second one.

## Close a session: `/ce`

`/ce` runs eight steps:

1. `cortex_detect_changes` on the diff; it warns when risk is HIGH.
2. `pnpm build && pnpm typecheck && pnpm lint`.
3. `cortex_quality_report` with the results.
4. Completes any Conductor task still in progress.
5. `cortex_knowledge_store` when the session found something the team should know.
6. `cortex_memory_store` with what was done, decisions and next steps.
7. `cortex_session_end` with a summary. The hub also saves that summary as memory, which is what
   the next `/cs` recalls.
8. A final report.

## Sessions nobody closed

- **Claude Code exits.** The SessionEnd hook closes the session through the hub with
  `auto: true`. It is recorded as abandoned, and its summary is kept out of memory recall, so a
  session that never ran `/ce` does not teach the next one.
- **The agent goes quiet.** Once an hour the hub marks sessions with no tool call for
  `SESSION_IDLE_HOURS` (default 72; `0` turns this off) as `expired`, not `completed`, so they are
  not recalled either. An agent that comes back after that gets a new session from its next `/cs`.

## Two agents, one repo

`cortex_changes(agentId, projectId)` returns the commits pushed since this agent last looked and
the files they touched. `/cs` calls it at start; call it again before you edit a shared file.
