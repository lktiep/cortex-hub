import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js';
/**
 * Register memory tools.
 * Proxies to mem0 API for agent memory storage and retrieval.
 * Supports branch-scoped knowledge via user_id namespacing:
 *   - project-{id}:branch-{name} → branch-specific memories
 *   - project-{id} → project-level memories (fallback)
 *   - {agentId} → agent-level memories (default)
 */
export declare function registerMemoryTools(server: McpServer, env: Env): void;
//# sourceMappingURL=memory.d.ts.map