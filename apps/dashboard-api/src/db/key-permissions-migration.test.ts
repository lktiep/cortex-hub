import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { ALL_TOOLS, MCP_TOOL_PERMISSIONS } from '@cortex/shared-types'
import { createTestDb } from '../conductor/testing.js'
import { grantAllToolsToFullKeys } from './key-permissions-migration.js'

const LEAD_GROUP = 'Conductor lead'
// What a key made with every box ticked before the conductor lead tools were listed holds.
const OLD_FULL = MCP_TOOL_PERMISSIONS.filter((p) => p.group !== LEAD_GROUP).map((p) => p.id)

let db: Database.Database

function addKey(id: string, permissions: string | null) {
  db.prepare("INSERT INTO api_keys (id, name, key_hash, scope, permissions) VALUES (?, ?, ?, 'all', ?)").run(id, id, `h-${id}`, permissions)
}

function permissionsOf(id: string): string | null {
  return (db.prepare('SELECT permissions FROM api_keys WHERE id = ?').get(id) as { permissions: string | null }).permissions
}

beforeEach(() => {
  db = createTestDb()
})

describe('grantAllToolsToFullKeys', () => {
  it('gives a key made with every box ticked every tool, in any order', () => {
    addKey('lead', JSON.stringify(OLD_FULL))
    addKey('shuffled', JSON.stringify([...OLD_FULL].reverse()))
    expect(grantAllToolsToFullKeys(db)).toBe(2)
    expect(permissionsOf('lead')).toBe(JSON.stringify([ALL_TOOLS]))
    expect(permissionsOf('shuffled')).toBe(JSON.stringify([ALL_TOOLS]))
  })

  it('keeps the list of a key with any box unticked, an empty list, NULL and junk', () => {
    const restricted = JSON.stringify(OLD_FULL.filter((id) => id !== 'cortex.memory.delete'))
    addKey('restricted', restricted)
    addKey('none', '[]')
    addKey('null', null)
    addKey('junk', 'not json')
    expect(grantAllToolsToFullKeys(db)).toBe(0)
    expect(permissionsOf('restricted')).toBe(restricted)
    expect(permissionsOf('none')).toBe('[]')
    expect(permissionsOf('null')).toBeNull()
    expect(permissionsOf('junk')).toBe('not json')
  })

  it('changes nothing the second time', () => {
    addKey('lead', JSON.stringify(OLD_FULL))
    grantAllToolsToFullKeys(db)
    expect(grantAllToolsToFullKeys(db)).toBe(0)
    expect(permissionsOf('lead')).toBe(JSON.stringify([ALL_TOOLS]))
  })
})
