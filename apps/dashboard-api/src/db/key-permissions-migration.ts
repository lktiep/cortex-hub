import type Database from 'better-sqlite3'
import { ALL_TOOLS } from '@cortex/shared-types'

// Every box the API Keys page offered up to v1.2.2. Frozen on purpose: a key holding all of
// them was made with every box ticked, before the page could store "every tool".
const PAGE_V122_PERMISSIONS: readonly string[] = [
  'cortex.session.start', 'cortex.session.end', 'cortex.changes',
  'cortex.code.search', 'cortex.code.context', 'cortex.code.impact', 'cortex.code.reindex',
  'cortex.list.repos', 'cortex.cypher', 'cortex.detect.changes',
  'cortex.memory.store', 'cortex.memory.search', 'cortex.memory.delete',
  'cortex.knowledge.store', 'cortex.knowledge.search',
  'cortex.quality.report', 'cortex.plan.quality',
  'cortex.task.create', 'cortex.task.pickup', 'cortex.task.accept', 'cortex.task.update',
  'cortex.task.list', 'cortex.task.status', 'cortex.task.submit.strategy',
  'cortex.health', 'cortex.tool.stats',
]

/**
 * A key made with every box ticked stored the ids the page knew then, so the conductor lead
 * tools added later stayed hidden from it. Such a key now stores ALL_TOOLS. A key with any of
 * those boxes unticked keeps its list. Returns how many keys changed; running it again changes none.
 */
export function grantAllToolsToFullKeys(db: Database.Database): number {
  const rows = db.prepare('SELECT id, permissions FROM api_keys WHERE permissions IS NOT NULL').all() as Array<{ id: string; permissions: string }>
  const update = db.prepare('UPDATE api_keys SET permissions = ? WHERE id = ?')
  let changed = 0
  for (const row of rows) {
    let stored: unknown
    try { stored = JSON.parse(row.permissions) } catch { continue }
    if (!Array.isArray(stored) || stored.includes(ALL_TOOLS)) continue
    if (PAGE_V122_PERMISSIONS.every((id) => stored.includes(id))) {
      update.run(JSON.stringify([ALL_TOOLS]), row.id)
      changed++
    }
  }
  return changed
}
