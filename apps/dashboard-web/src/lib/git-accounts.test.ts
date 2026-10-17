import { describe, expect, it } from 'vitest'
import type { GitAccount } from './api'
import { repoHost, savedAccountFor, savedUsernames } from './git-accounts'

const account = (host: string, username: string): GitAccount => ({
  host, username, projects: [{ id: `p-${username}`, name: username }], updatedAt: '2026-01-01T00:00:00Z',
})

describe('repoHost', () => {
  it.each([
    ['https://github.com/acme/app', 'github.com'],
    ['https://GitHub.com/acme/app.git', 'github.com'],
    ['git@github.com:acme/app.git', 'github.com'],
    ['ssh://git@gitlab.example.com:2222/acme/app.git', 'gitlab.example.com'],
  ])('reads %s', (url, host) => {
    expect(repoHost(url)).toBe(host)
  })

  it.each(['', 'app', 'github.com/acme/app'])('gives null for %j', (url) => {
    expect(repoHost(url)).toBeNull()
  })
})

describe('savedAccountFor', () => {
  const accounts = [account('github.com', 'Acme'), account('gitlab.com', 'bob')]

  it('matches the username case-insensitively on the URL\'s host', () => {
    expect(savedAccountFor(accounts, 'git@github.com:acme/new.git', ' acme ')?.username).toBe('Acme')
  })

  it('ignores the same username on another host', () => {
    expect(savedAccountFor(accounts, 'https://gitlab.com/acme/new', 'acme')).toBeNull()
  })

  it('needs both a URL and a username', () => {
    expect(savedAccountFor(accounts, '', 'acme')).toBeNull()
    expect(savedAccountFor(accounts, 'https://github.com/acme/new', '')).toBeNull()
  })
})

describe('savedUsernames', () => {
  it('lists each name once', () => {
    expect(savedUsernames([account('github.com', 'Acme'), account('gitlab.com', 'Acme'), account('github.com', 'bob')]))
      .toEqual(['Acme', 'bob'])
  })
})
