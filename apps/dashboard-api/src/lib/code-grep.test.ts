import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { grepArgs, grepCheckout, parseGrepOutput, MAX_LINE_CHARS } from './code-grep.js'

let repo: string

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'grep-'))
  mkdirSync(join(repo, 'net'))
  writeFileSync(join(repo, 'net', 'Handler.cs'), 'switch (op) {\n  case 144: TalkNpc(p); break;\n  case 145: Trade(p); break;\n}\n')
  writeFileSync(join(repo, 'notes.md'), 'Opcode 0x0090 is TalkNpc.\n-x flag\n')
  writeFileSync(join(repo, 'untracked.cs'), 'case 144: never committed\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo })
  git('init', '-q')
  git('add', 'net', 'notes.md')
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

describe('parseGrepOutput', () => {
  it('reads path, line and text, and cuts a long line', () => {
    const long = 'x'.repeat(MAX_LINE_CHARS + 50)
    const hits = parseGrepOutput(`a/b.cs\x0012\x00  case 1:\nc.md\x003\x00${long}\n`, true)
    expect(hits[0]).toEqual({ file: 'a/b.cs', line: 12, text: 'case 1:' })
    expect(hits[1]!.text.length).toBe(MAX_LINE_CHARS)
  })

  it('drops the last line of output that was cut off', () => {
    expect(parseGrepOutput('a.cs\x001\x00one\nb.cs\x002\x00tw', false)).toHaveLength(1)
  })
})

describe('grepArgs', () => {
  it('passes the pattern after -e so a leading dash is not an option', () => {
    const args = grepArgs('--open-files-in-pager=sh', '-F', {})
    expect(args[args.indexOf('-e') + 1]).toBe('--open-files-in-pager=sh')
  })
})

describe('grepCheckout', () => {
  it('finds a regex in tracked files only', async () => {
    const { hits, truncated } = await grepCheckout(repo, 'case 14\\d:')
    expect(truncated).toBe(false)
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual(['net/Handler.cs:2', 'net/Handler.cs:3'])
  })

  it('matches a plain string with fixed, and narrows by path', async () => {
    expect((await grepCheckout(repo, 'TalkNpc(p)', { fixed: true })).hits).toHaveLength(1)
    expect((await grepCheckout(repo, 'talknpc', { ignoreCase: true, paths: ['*.md'] })).hits.map((h) => h.file)).toEqual(['notes.md'])
    expect((await grepCheckout(repo, '-x', { fixed: true })).hits).toHaveLength(1)
  })

  it('answers no hits for no match, and refuses a broken pattern', async () => {
    expect((await grepCheckout(repo, 'NoSuchThing')).hits).toEqual([])
    await expect(grepCheckout(repo, 'case (14')).rejects.toThrow()
  })

  it('stops at the output budget and says so', async () => {
    const { hits, truncated } = await grepCheckout(repo, '.', { maxBytes: 30 })
    expect(truncated).toBe(true)
    expect(hits.length).toBeLessThan(3)
  })
})
