import { describe, it, expect } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ALL_TOOLS, MCP_TOOL_PERMISSIONS, allowedToolNames, toolNameForPermission } from '@cortex/shared-types'
import type { Env } from '../types.js'
import { registerAllTools } from './index.js'

function registeredTools(): string[] {
  const names: string[] = []
  const server = { tool: (name: string) => { names.push(name) } }
  registerAllTools(server as unknown as McpServer, { DASHBOARD_API_URL: 'http://api' } as Env)
  return names
}

describe('MCP_TOOL_PERMISSIONS', () => {
  // The API Keys page grants tools from this list. A tool missing from it can never be
  // ticked, so every key made on that page hid it — as happened to the conductor lead tools.
  it('names every tool hub-mcp registers, and nothing else', () => {
    const granted = MCP_TOOL_PERMISSIONS.map((p) => toolNameForPermission(p.id))
    expect([...granted].sort()).toEqual(registeredTools().sort())
  })

  it('has no duplicate ids', () => {
    const ids = MCP_TOOL_PERMISSIONS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('allowedToolNames', () => {
  it('lets every tool through for no list, or a list holding ALL_TOOLS', () => {
    expect(allowedToolNames(undefined)).toBeNull()
    expect(allowedToolNames([ALL_TOOLS])).toBeNull()
    expect(allowedToolNames(['cortex.health', ALL_TOOLS])).toBeNull()
  })

  it('lets through only the tools a list names', () => {
    expect(allowedToolNames(['cortex.agents', 'cortex.task.tree.create'])).toEqual(new Set(['cortex_agents', 'cortex_task_tree_create']))
  })

  it('lets nothing through for an empty list', () => {
    expect(allowedToolNames([])).toEqual(new Set())
  })
})
