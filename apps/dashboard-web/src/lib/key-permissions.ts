import { ALL_TOOLS, MCP_TOOL_PERMISSIONS } from '@cortex/shared-types'

const allIds = MCP_TOOL_PERMISSIONS.map((p) => p.id)

/** The boxes ticked for a key's stored permissions. A key holding ALL_TOOLS has all of them. */
export function tickedPermissions(stored: readonly string[] | undefined): string[] {
  if (stored?.includes(ALL_TOOLS)) return [...allIds]
  return [...(stored ?? [])]
}

/**
 * What a key stores for the ticked boxes. With every box ticked it stores ALL_TOOLS, so
 * the key also gets the tools a later version adds instead of silently missing them.
 */
export function permissionsToSave(ticked: readonly string[]): string[] {
  return allIds.every((id) => ticked.includes(id)) ? [ALL_TOOLS] : [...ticked]
}
