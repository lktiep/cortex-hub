import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types.js'
import { registerCodeTools } from './code.js'
import { registerHealthTools } from './health.js'
import { registerIndexingTools } from './indexing.js'
import { registerKnowledgeTools } from './knowledge.js'
import { registerMemoryTools } from './memory.js'
import { registerQualityTools } from './quality.js'
import { registerSessionTools } from './session.js'
import { registerChangeTools } from './changes.js'
import { registerAnalyticsTools } from './analytics.js'
import { registerTaskTools } from './tasks.js'
import { registerConductorLeadTools } from './conductor-lead.js'

/** Register every hub tool. A new tool also needs its entry in MCP_TOOL_PERMISSIONS. */
export function registerAllTools(server: McpServer, env: Env): void {
  registerHealthTools(server, env)
  registerMemoryTools(server, env)
  registerKnowledgeTools(server, env)
  registerCodeTools(server, env)
  registerIndexingTools(server, env)
  registerQualityTools(server, env)
  registerSessionTools(server, env)
  registerChangeTools(server, env)
  registerAnalyticsTools(server, env)
  registerTaskTools(server, env)
  registerConductorLeadTools(server, env)
}
