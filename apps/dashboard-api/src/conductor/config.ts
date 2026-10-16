import { db } from '../db/client.js'
import type { RouteSpec, Executor } from '@cortex/shared-types'
import { EXECUTORS } from '@cortex/shared-types'

export interface ConductorConfig {
  defaultFallback: RouteSpec[]
  branchTemplate: string
  offlineReclaimMinutes: number
  leaseHours: number
}

const DEFAULT_FALLBACK: RouteSpec[] = [{ executor: 'claude', model: 'opus', effort: null }]

function readConfig(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM hub_config WHERE key = ?').get(`conductor.${key}`) as { value: string } | undefined
  return row?.value
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function normaliseRoutes(raw: string | undefined): RouteSpec[] {
  if (raw === undefined) return DEFAULT_FALLBACK
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_FALLBACK
    return parsed
      .filter((r): r is Record<string, unknown> => r !== null && typeof r === 'object')
      .map((r) => {
        const ex = str(r.executor)
        return {
          executor: ex !== null && (EXECUTORS as readonly string[]).includes(ex) ? (ex as Executor) : null,
          model: str(r.model),
          effort: str(r.effort),
        }
      })
  } catch {
    return DEFAULT_FALLBACK
  }
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function getConductorConfig(): ConductorConfig {
  return {
    defaultFallback: normaliseRoutes(readConfig('defaultFallback')),
    branchTemplate: str(readConfig('branchTemplate')) ?? 'cx/{key}-{slug}',
    offlineReclaimMinutes: positiveNumber(readConfig('offlineReclaimMinutes'), 30),
    leaseHours: positiveNumber(readConfig('leaseHours'), 24),
  }
}

export function baseBranchFor(projectId: string | null): string {
  const configured = str(readConfig('baseBranch'))
  if (configured !== null) return configured
  if (projectId !== null) {
    const row = db.prepare('SELECT default_branch FROM projects WHERE id = ?').get(projectId) as { default_branch: string | null } | undefined
    const b = str(row?.default_branch)
    if (b !== null) return b
  }
  return 'main'
}
