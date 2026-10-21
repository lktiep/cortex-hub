# Knowledge and memory

The hub keeps two stores. They answer different questions.

| | Knowledge | Memory |
|---|---|---|
| Who sees it | The whole team on the project | Recalled by project, branch and agent |
| What goes in | Fixes, patterns, decisions, risks | Session context: what was done, what is next |
| Store | `cortex_knowledge_store(title, content)` | `cortex_memory_store(content)` |
| Recall | `cortex_knowledge_search(query)` | `cortex_memory_search(query)` |

Both are embedded and searched by meaning. `/cs` runs both searches at the start of every session,
and the hooks refuse edits until they have run. They are for errors and decisions, not for
finding code: use the [code tools](./code-intelligence) for that.

## Knowledge

```
cortex_knowledge_store(
  title: "SQLite busy errors under parallel tests",
  content: "Cause: … Fix: … Verified by: …",
  tags: ["sqlite", "testing"],
  category: "error_fix",
  files: ["apps/dashboard-api/src/db/client.ts"]
)
```

| Parameter | Values |
|---|---|
| `category` | `risk`, `lesson`, `error_fix`, `pattern`, `decision`, `general` |
| `hallType` | `fact`, `event`, `discovery`, `preference`, `advice`, `general` (default) |
| `validFrom` | ISO date the fact became true. Search with `asOf` to get only what was valid on a date |
| `files` | Repo-relative files or `dir/` the note is about. See file notes below |
| `tags`, `projectId`, `agentId` | Filters and attribution |

`cortex_knowledge_search` takes `query`, plus `tags`, `projectId`, `hallType`, `asOf` and `limit`
(default 5). Results marked deprecated carry a warning.

On the dashboard, **Knowledge** lists every document, groups them by project, creates new ones by
hand and exports them as JSON.

### When something breaks

1. `cortex_knowledge_search(query: "<error message>")`: someone may have fixed it.
2. `cortex_memory_search(query: "<error context>")`: you may have seen it before.
3. Fix it.
4. If the fix was not obvious, store it with `cortex_knowledge_store`.

## File notes

A note stored with `files: [...]` is linked to those paths. So are the risks a Conductor task
reports when it completes. The next agent that is about to read or edit one of those files gets
the notes as context, without having to know a search would have found them:

- In Claude Code, the `recall-notes.sh` hook asks the hub once for every linked path of the
  project (`cortex_file_notes`), caches the answer for ten minutes, and shows up to three notes per
  file, once per conversation and agent. It never blocks. `CORTEX_NOTES=off` turns it off.
- Code tool results that name a linked file have its notes appended.

`cortex_file_notes(repo, files)` returns them directly, as JSON keyed by path.

## Memory

```
cortex_memory_store(content: "Moved retries into the client; next: wire the dashboard toggle", branch: "feat/retry")
cortex_memory_search(query: "retry work", branch: "feat/retry")
```

`branch` needs `projectId`. A search on a branch falls back to the whole project when the branch
has nothing. `cortex_memory_delete(id)` removes one entry.

`cortex_session_end` saves the session summary as memory, which is what the next `/cs` recalls.
A session closed automatically (the agent exited without `/ce`) is kept out of that recall.
