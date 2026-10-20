import { describe, it, expect } from 'vitest'
import { claimTreeUpload, issueTreeUpload, releaseTreeUpload, TREE_UPLOAD_TTL_MS } from './tree-upload.js'

const T0 = 1_800_000_000_000

describe('tree upload grants', () => {
  it('issues an unguessable token that names the agent who asked', () => {
    const a = issueTreeUpload('lead-a', T0)
    const b = issueTreeUpload('lead-a', T0)
    expect(a.token).toMatch(/^[0-9a-f]{48}$/)
    expect(b.token).not.toBe(a.token)
    expect(a.expiresAt).toBe(T0 + TREE_UPLOAD_TTL_MS)
    expect(claimTreeUpload(a.token, T0 + 1)).toEqual({ ok: true, owner: 'lead-a' })
  })

  it('refuses an unknown or expired token with 404', () => {
    const { token } = issueTreeUpload('lead-a', T0)
    expect(claimTreeUpload('nope', T0)).toMatchObject({ ok: false, status: 404 })
    expect(claimTreeUpload(token, T0 + TREE_UPLOAD_TTL_MS + 1)).toMatchObject({ ok: false, status: 404 })
  })

  it('refuses a second upload while the first is running, so one link cannot create two trees', () => {
    const { token } = issueTreeUpload(undefined, T0)
    expect(claimTreeUpload(token, T0)).toEqual({ ok: true, owner: undefined })
    expect(claimTreeUpload(token, T0)).toMatchObject({ ok: false, status: 409 })
  })

  it('keeps the link after a rejected file, and spends it on a created tree', () => {
    const { token } = issueTreeUpload('lead-a', T0)
    claimTreeUpload(token, T0)
    releaseTreeUpload(token, false)
    expect(claimTreeUpload(token, T0)).toEqual({ ok: true, owner: 'lead-a' })
    releaseTreeUpload(token, true)
    expect(claimTreeUpload(token, T0)).toMatchObject({ ok: false, status: 404 })
  })

  it('drops expired grants when a new one is issued', () => {
    const old = issueTreeUpload('lead-a', T0)
    issueTreeUpload('lead-a', T0 + TREE_UPLOAD_TTL_MS + 1)
    // still expired from the point of view of a clock that went backwards: the grant is gone, not just stale
    expect(claimTreeUpload(old.token, T0)).toMatchObject({ ok: false, status: 404 })
  })
})
