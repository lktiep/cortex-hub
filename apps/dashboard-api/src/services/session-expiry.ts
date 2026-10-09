import { createLogger } from '@cortex/shared-utils'
import { db } from '../db/client.js'

// ── Session expiry ──
//
// A session closes when its agent runs /ce or the Stop hook reaches the hub. When
// neither happens (a closed terminal, a hook pointed at a hub it cannot reach) the
// row stays 'active' for good, and the dashboard counted over a hundred of them on
// one project. Sessions with no tool call for SESSION_IDLE_HOURS are marked
// 'expired' here. That is not 'completed' on purpose: /cs recalls the summaries of
// completed sessions, and an expired one has nothing to recall. An agent that comes
// back after that long gets a new session from its next /cs.

const logger = createLogger('session-expiry')

const FIRST_RUN_DELAY_MS = 60 * 1000
const RUN_INTERVAL_MS = 60 * 60 * 1000
const DEFAULT_IDLE_HOURS = 72

/** Hours without activity before a session expires; 0 turns expiry off. */
export function sessionIdleHours(): number {
  const raw = process.env.SESSION_IDLE_HOURS?.trim()
  if (!raw) return DEFAULT_IDLE_HOURS
  const hours = Number(raw)
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_IDLE_HOURS
  return hours
}

/** Mark active sessions idle for longer than `hours` as expired; returns how many. */
export function expireIdleSessions(hours: number): number {
  if (hours <= 0) return 0
  const { changes } = db.prepare(
    `UPDATE session_handoffs
        SET status = 'expired'
      WHERE status = 'active'
        AND COALESCE(last_activity, created_at) < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)`
  ).run(`-${hours} hours`)
  return changes
}

/** Expire a minute after start, then every hour. Off when SESSION_IDLE_HOURS is 0. */
export function scheduleSessionExpiry(): void {
  const hours = sessionIdleHours()
  if (hours <= 0) {
    logger.info('Session expiry off (SESSION_IDLE_HOURS=0)')
    return
  }
  logger.info(`Session expiry on: active sessions idle for ${hours} hours are marked expired`)
  const run = () => {
    try {
      const expired = expireIdleSessions(hours)
      if (expired > 0) logger.info(`Session expiry: ${expired} session(s) idle for ${hours} hours expired`)
    } catch (err) {
      logger.warn(`Session expiry failed: ${String(err).slice(0, 200)}`)
    }
  }
  setTimeout(run, FIRST_RUN_DELAY_MS).unref()
  setInterval(run, RUN_INTERVAL_MS).unref()
}
