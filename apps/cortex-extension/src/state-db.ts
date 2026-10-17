import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The state database of the IDE this extension runs in. VS Code keeps each extension's global
 * storage beside it (`<user data>/User/globalStorage/<extension id>`), so this follows the IDE's
 * own user-data folder: "Antigravity IDE" for the current app, or a portable or `--user-data-dir`
 * one. antigravity-sdk 1.7.0 looks only in an "Antigravity" folder, which a new install does not
 * have (its init fails) and which, where the old app is also installed, is the old app's database.
 */
export function ownStateDb(globalStoragePath: string, exists: (path: string) => boolean = existsSync): string | null {
  const db = join(dirname(globalStoragePath), 'state.vscdb')
  return exists(db) ? db : null
}

/**
 * Makes the SDK open `db` instead of searching for one. `_findStateDb` is private in the SDK, so
 * this returns false, and changes nothing, if a later SDK no longer has it.
 */
export function pointSdkAtStateDb(sdk: { state: object }, db: string): boolean {
  const state = sdk.state as { _findStateDb?: unknown }
  if (typeof state._findStateDb !== 'function') return false
  state._findStateDb = () => db
  return true
}
