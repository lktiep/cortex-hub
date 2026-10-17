'use client'

// Which tasks changed state since the last poll. Each id stays in the set for FLASH_MS, so the
// board and the graph can light up what just moved.
import { useEffect, useRef, useState } from 'react'
import { changedStates } from '@/lib/conductor-plan/board'
import type { PlanState, PlanTask } from '@/lib/conductor-plan/model'

export const FLASH_MS = 1600

export function usePlanFlash(tasks: PlanTask[]): ReadonlySet<string> {
  const previous = useRef<Map<string, PlanState> | null>(null)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    const before = previous.current
    previous.current = new Map(tasks.map((t) => [t.id, t.state]))
    const changed = before ? changedStates(before, tasks) : []
    if (changed.length === 0) return
    setFlashing((cur) => new Set([...cur, ...changed]))
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setFlashing((cur) => {
        const next = new Set(cur)
        for (const id of changed) next.delete(id)
        return next
      })
    }, FLASH_MS)
    timers.current.add(timer)
  }, [tasks])

  useEffect(() => {
    const live = timers.current
    return () => {
      for (const t of live) clearTimeout(t)
    }
  }, [])

  return flashing
}
