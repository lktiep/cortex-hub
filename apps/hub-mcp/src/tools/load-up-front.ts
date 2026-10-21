// Claude Code defers an MCP tool until a ToolSearch call loads its schema: one more turn before
// the agent can call it. The tools every conversation reaches for first load with the session:
// the session start, the two recalls the hooks require before any edit, and the two lookups an
// agent finds code with. The rest stay deferred.
export const LOAD_UP_FRONT = { _meta: { 'anthropic/alwaysLoad': true } }
