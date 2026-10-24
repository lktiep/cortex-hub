// Claude Code defers an MCP tool until a ToolSearch call loads its schema: one more turn before
// the agent can call it. The tools every conversation reaches for first load with the session:
// the session start and the two lookups an agent finds code with. Each schema is carried on every
// turn, so the recalls stay deferred: the start's answer holds the recall for the task, and a
// later search for an error is worth the one ToolSearch turn.
export const LOAD_UP_FRONT = { _meta: { 'anthropic/alwaysLoad': true } }
