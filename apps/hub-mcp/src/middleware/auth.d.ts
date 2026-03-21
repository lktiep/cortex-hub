import type { Env } from '../types.js'
/**
 * API key authentication middleware for MCP requests.
 *
 * Verifies the Bearer token by pinging the Dashboard API
 * which validates the hashed token against the SQLite database.
 */
export declare function validateApiKey(request: Request, env: Env): Promise<{
    valid: boolean;
    error?: string;
    agentId?: string;
    scope?: string;
}>;
//# sourceMappingURL=auth.d.ts.map