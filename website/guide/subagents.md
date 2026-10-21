# Subagents

A Claude Code subagent starts with the prompt its parent wrote and nothing else. It has none of
the recall `/cs` did, so it would edit files without knowing the fixes and risks the team has
stored for them. The hooks treat it as its own agent.

## What happens

1. **When it starts**, the `subagent-start.sh` hook (SubagentStart) adds a short note to its
   context: it is in a Cortex session, the parent's recall is not in its context, and it must run
   `cortex_knowledge_search` and `cortex_memory_search` on its own task before editing. It also
   gets the rules for finding code.
2. **When it tries to edit**, `enforce-session.sh` looks for recall markers filed under the
   subagent's own id (`.cortex/.session-state/agents/<agent_id>/`). The parent's markers do not
   count. Until the subagent has run both searches, its edits are refused.
3. **When it reads or edits a file** with linked notes, `recall-notes.sh` shows them to it, once
   per subagent. See [file notes](./knowledge-memory#file-notes).

The session itself is shared: a subagent does not call `cortex_session_start`. If the checkout has
no Cortex session, or the gates are declared off, the SubagentStart hook says nothing.

## Writing a subagent prompt

The subagent searches on its own task, so say what the task is in terms a search can use: the
error message, the feature, the files. A prompt like "fix the bug we discussed" gives it nothing
to recall with.
