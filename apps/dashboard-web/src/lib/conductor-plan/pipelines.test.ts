import { describe, expect, it } from 'vitest'
import type { ConductorTask } from '../api'
import { pipelineTasks } from './pipelines'

const task = (id: string, status: string, parent: string | null = null): ConductorTask =>
  ({ id, status, parent_task_id: parent }) as unknown as ConductorTask

describe('pipelineTasks', () => {
  const tasks = [
    task('big', 'pending'),
    task('g1', 'completed', 'big'),
    task('a', 'in_progress', 'g1'),
    task('b', 'completed', 'g1'),
    task('solo', 'completed'),
    task('stray', 'failed', 'gone'),
  ]
  const ids = (list: ConductorTask[]): string[] => list.map((t) => t.id)

  it('keeps the whole tree when any task in it matches', () => {
    expect(ids(pipelineTasks(tasks, (t) => t.status === 'in_progress'))).toEqual(['big', 'g1', 'a', 'b'])
    expect(ids(pipelineTasks(tasks, (t) => t.status === 'completed'))).toEqual(['big', 'g1', 'a', 'b', 'solo'])
  })

  it('treats a task whose parent is not loaded as its own tree', () => {
    expect(ids(pipelineTasks(tasks, (t) => t.status === 'failed'))).toEqual(['stray'])
    expect(pipelineTasks(tasks, (t) => t.status === 'cancelled')).toEqual([])
  })
})
