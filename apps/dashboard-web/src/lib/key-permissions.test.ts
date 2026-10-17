import { describe, expect, it } from 'vitest'
import { ALL_TOOLS, MCP_TOOL_PERMISSIONS } from '@cortex/shared-types'
import { permissionsToSave, tickedPermissions } from './key-permissions'

const allIds = MCP_TOOL_PERMISSIONS.map((p) => p.id)

describe('permissionsToSave', () => {
  it('stores ALL_TOOLS once every box is ticked, whatever the order', () => {
    expect(permissionsToSave([...allIds].reverse())).toEqual([ALL_TOOLS])
  })

  it('stores the ticked ids while any box is unticked', () => {
    const ticked = allIds.filter((id) => id !== 'cortex.task.cancel')
    expect(permissionsToSave(ticked)).toEqual(ticked)
    expect(permissionsToSave([])).toEqual([])
  })
})

describe('tickedPermissions', () => {
  it('ticks every box for a key holding ALL_TOOLS', () => {
    expect(tickedPermissions([ALL_TOOLS])).toEqual(allIds)
  })

  it('ticks only the stored ids otherwise', () => {
    expect(tickedPermissions(['cortex.health'])).toEqual(['cortex.health'])
    expect(tickedPermissions(undefined)).toEqual([])
  })

  it('round-trips a key made with every box ticked', () => {
    expect(permissionsToSave(tickedPermissions(permissionsToSave(allIds)))).toEqual([ALL_TOOLS])
  })
})
