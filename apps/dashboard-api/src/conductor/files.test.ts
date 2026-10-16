import { describe, expect, it } from 'vitest'
import { normalizeFiles, normalizePath, pathsConflict } from './files.js'

describe('files', () => {
  it('normalizes backslashes and ./ before comparing', () => {
    expect(normalizePath('.\\src\\\\inv\\')).toBe('src/inv/')
    expect(pathsConflict(['src\\inv\\a.ts'], ['./src/inv/a.ts'])).toBe(true)
  })

  it('strips a leading /', () => {
    expect(normalizePath('/src/a.ts')).toBe('src/a.ts')
    expect(pathsConflict(['/src/a.ts'], ['src/a.ts'])).toBe(true)
  })

  it('directory prefix', () => {
    expect(pathsConflict(['src/inv/'], ['src/inv/a.ts'])).toBe(true)
    expect(pathsConflict(['src/inv/'], ['src/inventory.ts'])).toBe(false)
    expect(pathsConflict([], ['x'])).toBe(false)
  })

  it('rejects globs', () => {
    expect(() => normalizeFiles(['src/*.ts'])).toThrow('globs are not supported: src/*.ts')
    expect(() => normalizeFiles(['src/a?.ts'])).toThrow('globs are not supported: src/a?.ts')
    expect(() => normalizeFiles(['src/[ab].ts'])).toThrow('globs are not supported: src/[ab].ts')
    expect(normalizeFiles(['./a.ts', 'b\\c.ts'])).toEqual(['a.ts', 'b/c.ts'])
  })

  it('rejects empty, root and .. paths', () => {
    for (const p of ['', '.', './', '/']) {
      expect(() => normalizeFiles([p])).toThrow(new Error(`invalid path: ${p}`))
    }
    expect(() => normalizeFiles(['src/../lib/a.ts'])).toThrow('invalid path: src/../lib/a.ts')
    expect(() => normalizeFiles(['..\\a.ts'])).toThrow('invalid path: ..\\a.ts')
  })
})
