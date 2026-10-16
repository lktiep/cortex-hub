import { describe, expect, it } from 'vitest'
import { normalizeFiles, normalizePath, pathsConflict } from './files.js'

describe('files', () => {
  it('normalizes backslashes and ./ before comparing', () => {
    expect(normalizePath('.\\src\\\\inv\\')).toBe('src/inv/')
    expect(pathsConflict(['src\\inv\\a.ts'], ['./src/inv/a.ts'])).toBe(true)
  })

  it('directory prefix', () => {
    expect(pathsConflict(['src/inv/'], ['src/inv/a.ts'])).toBe(true)
    expect(pathsConflict(['src/inv/'], ['src/inventory.ts'])).toBe(false)
    expect(pathsConflict([], ['x'])).toBe(false)
  })

  it('rejects globs', () => {
    expect(() => normalizeFiles(['src/*.ts'])).toThrow('globs are not supported: src/*.ts')
    expect(normalizeFiles(['./a.ts', 'b\\c.ts'])).toEqual(['a.ts', 'b/c.ts'])
  })
})
