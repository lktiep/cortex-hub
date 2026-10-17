import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { STATUS_COLOR, STATUS_LABEL } from './status'

describe('status', () => {
  it('has a colour and a label for every state', () => {
    expect(Object.keys(STATUS_COLOR).sort()).toEqual(Object.keys(STATUS_LABEL).sort())
    expect(STATUS_COLOR.done).toBe('#34d399')
  })
  it('the plan model modules stay free of React and the DOM', () => {
    for (const f of ['summary.ts', 'status.ts', 'board.ts', 'graph.ts', 'layout.ts']) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
      expect(src).not.toMatch(/from 'react|@xyflow|document\.|window\./)
    }
  })
})
