import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js';
/**
 * Register code intelligence tools.
 * Proxies AST graph, impact analysis, and code search requests to the Dashboard API
 * which routes them natively to the GitNexus backend on the server.
 * Supports project + branch scoping for multi-branch knowledge.
 */
export declare function registerCodeTools(server: McpServer, env: Env): void;
//# sourceMappingURL=code.d.ts.map