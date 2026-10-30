/**
 * One-time links for importing a plan tree from a file.
 *
 * A plan of 80 tasks with real descriptions is hundreds of KB. Sent as tool arguments, the
 * model has to type all of it into one reply, which it cannot, so it splits the plan into
 * dozens of batches and the user approves each one. Instead `cortex_task_tree_create`
 * (upload: true) hands out a link and the agent posts its plan file there with curl.
 *
 * The token is the credential: it names the agent that asked for it, it can only create a
 * tree, it lasts TREE_UPLOAD_TTL_MS, and a created tree spends it. A rejected file does not,
 * so the agent fixes the file and sends it again. Grants live in this process: a restart drops
 * them and the agent asks for a new link. That is fine for the one hub-mcp process we run; a
 * second replica would need them in the dashboard API.
 */

export const TREE_UPLOAD_TTL_MS = 15 * 60 * 1000
export const MAX_TREE_UPLOAD_BYTES = 5 * 1024 * 1024

interface Grant {
  owner: string | undefined
  /** The key that asked for the link; the upload acts with that key's organizations. */
  keyId?: string
  expiresAt: number
  /** An upload with this link is being created right now. */
  busy: boolean
}

const grants = new Map<string, Grant>()

export type TreeUploadClaim =
  | { ok: true; owner: string | undefined; keyId?: string }
  | { ok: false; status: 404 | 409; error: string }

export function issueTreeUpload(owner: string | undefined, now = Date.now(), keyId?: string): { token: string; expiresAt: number } {
  for (const [token, g] of grants) {
    if (g.expiresAt <= now) grants.delete(token)
  }
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  const expiresAt = now + TREE_UPLOAD_TTL_MS
  grants.set(token, { owner, keyId, expiresAt, busy: false })
  return { token, expiresAt }
}

/** Take the link for one upload. Every successful claim must be followed by releaseTreeUpload. */
export function claimTreeUpload(token: string, now = Date.now()): TreeUploadClaim {
  const g = grants.get(token)
  if (!g || g.expiresAt <= now) {
    return { ok: false, status: 404, error: 'This upload link is unknown, used or expired. Call cortex_task_tree_create with upload: true for a new one.' }
  }
  if (g.busy) return { ok: false, status: 409, error: 'A plan is already being uploaded with this link. Wait for it to finish.' }
  g.busy = true
  return { ok: true, owner: g.owner, keyId: g.keyId }
}

/** End an upload: a created tree spends the link, anything else leaves it for another try. */
export function releaseTreeUpload(token: string, created: boolean): void {
  const g = grants.get(token)
  if (!g) return
  if (created) grants.delete(token)
  else g.busy = false
}
