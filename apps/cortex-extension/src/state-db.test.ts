import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownStateDb, pointSdkAtStateDb } from './state-db.js'

const storage = join('/u', 'Antigravity IDE', 'User', 'globalStorage', 'cortex-hub.cortex-agent')
const db = join('/u', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb')

describe('ownStateDb', () => {
  it("is the state.vscdb beside this extension's global storage, whatever the app folder is called", () => {
    expect(ownStateDb(storage, (p) => p === db)).toBe(db)
  })

  it('is null when that file is missing, so the SDK searches as before', () => {
    expect(ownStateDb(storage, () => false)).toBeNull()
  })
})

describe('pointSdkAtStateDb', () => {
  it("makes the SDK's state bridge open that file instead of its own guess", () => {
    const state = { _findStateDb: (): string | null => join('/u', 'Antigravity', 'User', 'globalStorage', 'state.vscdb') }
    expect(pointSdkAtStateDb({ state }, db)).toBe(true)
    expect(state._findStateDb()).toBe(db)
  })

  it('reports false and changes nothing when the SDK has no such lookup', () => {
    const state = {}
    expect(pointSdkAtStateDb({ state }, db)).toBe(false)
    expect(state).toEqual({})
  })

  it('matches the installed SDK: its state bridge opens whatever _findStateDb returns', () => {
    const sdkMain = createRequire(__filename).resolve('antigravity-sdk')
    expect(readFileSync(sdkMain, 'utf8')).toContain('const dbPath = this._findStateDb();')
  })
})
