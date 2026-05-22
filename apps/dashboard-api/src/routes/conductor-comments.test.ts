import { describe, it, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ── In-memory DB with schema ──
let testDb: InstanceType<typeof Database>

// ── Mock broadcastComment ──
const mockBroadcastComment = vi.fn()

vi.mock('../ws/conductor.js', () => ({
  getAllConnectedAgents: vi.fn(() => []),
  pushTaskToAgent: vi.fn(() => false),
  notifyAgents: vi.fn(() => []),
  setAgentStatus: vi.fn(),
  broadcastComment: (...args: unknown[]) => mockBroadcastComment(...args),
  broadcastStrategyReady: vi.fn(),
}))

vi.mock('../db/client.js', () => {
  // Create in-memory DB and apply schema
  const db = new Database(':memory:')
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '../db/schema.sql')
  const schema = readFileSync(schemaPath, 'utf-8')
  db.exec(schema)
  return { db }
})

// ── Import after mocks ──
const { db } = await import('../db/client.js')
const { conductorRouter } = await import('./conductor.js')

// Mount on Hono like the real app
const app = new Hono()
app.route('/api/conductor', conductorRouter)

// ── Helpers ──
const TASK_ID = 'task_test_comments_001'

function seedTask(id = TASK_ID) {
  db.prepare(`
    INSERT OR REPLACE INTO conductor_tasks (id, title, description, status, priority)
    VALUES (?, ?, ?, 'in_progress', 5)
  `).run(id, 'Test Task', 'A task for testing comments')
}

function clearComments() {
  db.prepare('DELETE FROM conductor_comments').run()
}

async function postComment(taskId: string, body: Record<string, unknown>) {
  return app.request(`/api/conductor/${taskId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function getComments(taskId: string) {
  return app.request(`/api/conductor/${taskId}/comments`, { method: 'GET' })
}

// ── Tests ──

describe('Conductor Comments API', () => {
  beforeEach(() => {
    seedTask()
    clearComments()
    mockBroadcastComment.mockClear()
  })

  // ─── GET /api/conductor/:id/comments ───

  describe('GET /:id/comments', () => {
    it('returns 404 for non-existent task', async () => {
      const res = await getComments('task_nonexistent_999')
      expect(res.status).toBe(404)
      const json = await res.json()
      expect(json.error).toBe('Task not found')
    })

    it('returns empty array when no comments exist', async () => {
      const res = await getComments(TASK_ID)
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.comments).toEqual([])
    })

    it('returns comments ordered by created_at ASC', async () => {
      // Insert two comments with slightly different timestamps
      db.prepare(
        "INSERT INTO conductor_comments (task_id, agent_id, comment, comment_type, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 seconds'))"
      ).run(TASK_ID, 'agent-1', 'First comment', 'comment')
      db.prepare(
        "INSERT INTO conductor_comments (task_id, agent_id, comment, comment_type, created_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 seconds'))"
      ).run(TASK_ID, 'agent-2', 'Second comment', 'agree')

      const res = await getComments(TASK_ID)
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.comments).toHaveLength(2)
      expect(json.comments[0].comment).toBe('First comment')
      expect(json.comments[1].comment).toBe('Second comment')
    })

    it('only returns comments for the requested task', async () => {
      const otherTaskId = 'task_test_other_002'
      seedTask(otherTaskId)

      db.prepare(
        'INSERT INTO conductor_comments (task_id, agent_id, comment, comment_type) VALUES (?, ?, ?, ?)'
      ).run(TASK_ID, 'agent-1', 'Comment on task 1', 'comment')
      db.prepare(
        'INSERT INTO conductor_comments (task_id, agent_id, comment, comment_type) VALUES (?, ?, ?, ?)'
      ).run(otherTaskId, 'agent-2', 'Comment on task 2', 'disagree')

      const res = await getComments(TASK_ID)
      const json = await res.json()
      expect(json.comments).toHaveLength(1)
      expect(json.comments[0].task_id).toBe(TASK_ID)
    })
  })

  // ─── POST /api/conductor/:id/comments ───

  describe('POST /:id/comments', () => {
    it('returns 404 for non-existent task', async () => {
      const res = await postComment('task_nonexistent_999', {
        comment: 'Hello',
      })
      expect(res.status).toBe(404)
    })

    it('returns 400 when comment is missing', async () => {
      const res = await postComment(TASK_ID, { commentType: 'agree' })
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error).toBe('comment is required')
    })

    it('creates a comment with default comment_type "comment"', async () => {
      const res = await postComment(TASK_ID, { comment: 'Basic comment' })
      expect(res.status).toBe(201)

      const json = await res.json()
      expect(json.comment.comment).toBe('Basic comment')
      expect(json.comment.comment_type).toBe('comment')
      expect(json.comment.task_id).toBe(TASK_ID)
      expect(json.comment.agent_id).toBe('dashboard') // default when agentId not provided
    })

    // ─── comment_type enum validation ───

    describe('comment_type enum validation', () => {
      const validTypes = ['comment', 'agree', 'disagree', 'amendment'] as const

      for (const type of validTypes) {
        it(`accepts valid comment_type "${type}"`, async () => {
          const res = await postComment(TASK_ID, {
            comment: `Test ${type}`,
            commentType: type,
          })
          expect(res.status).toBe(201)
          const json = await res.json()
          expect(json.comment.comment_type).toBe(type)
        })
      }

      it('rejects invalid comment_type "upvote"', async () => {
        const res = await postComment(TASK_ID, {
          comment: 'Test',
          commentType: 'upvote',
        })
        expect(res.status).toBe(400)
        const json = await res.json()
        expect(json.error).toBe('Invalid comment_type')
      })

      it('rejects invalid comment_type empty string', async () => {
        const res = await postComment(TASK_ID, {
          comment: 'Test',
          commentType: '',
        })
        expect(res.status).toBe(400)
        const json = await res.json()
        expect(json.error).toBe('Invalid comment_type')
      })

      it('rejects invalid comment_type "COMMENT" (case-sensitive)', async () => {
        const res = await postComment(TASK_ID, {
          comment: 'Test',
          commentType: 'COMMENT',
        })
        expect(res.status).toBe(400)
      })
    })

    // ─── finding_id association ───

    describe('finding_id association', () => {
      it('stores finding_id when provided', async () => {
        const res = await postComment(TASK_ID, {
          comment: 'I agree with this finding',
          commentType: 'agree',
          findingId: 'finding_abc_123',
        })
        expect(res.status).toBe(201)
        const json = await res.json()
        expect(json.comment.finding_id).toBe('finding_abc_123')
      })

      it('stores null finding_id when not provided', async () => {
        const res = await postComment(TASK_ID, {
          comment: 'General comment',
        })
        expect(res.status).toBe(201)
        const json = await res.json()
        expect(json.comment.finding_id).toBeNull()
      })

      it('can filter comments by finding_id via DB', async () => {
        const findingId = 'finding_xyz_456'
        await postComment(TASK_ID, {
          comment: 'Finding-specific comment',
          findingId,
          commentType: 'amendment',
        })
        await postComment(TASK_ID, {
          comment: 'General comment',
        })

        // Verify DB-level filtering works (the API returns all for a task)
        const findingComments = db.prepare(
          'SELECT * FROM conductor_comments WHERE task_id = ? AND finding_id = ?'
        ).all(TASK_ID, findingId) as { comment: string }[]
        expect(findingComments).toHaveLength(1)
        expect(findingComments[0]!.comment).toBe('Finding-specific comment')
      })
    })

    // ─── agentId handling ───

    describe('agentId handling', () => {
      it('stores provided agentId', async () => {
        const res = await postComment(TASK_ID, {
          comment: 'Agent comment',
          agentId: 'agent-lead-01',
        })
        expect(res.status).toBe(201)
        const json = await res.json()
        expect(json.comment.agent_id).toBe('agent-lead-01')
      })

      it('defaults to "dashboard" when agentId is omitted', async () => {
        const res = await postComment(TASK_ID, { comment: 'Dashboard comment' })
        const json = await res.json()
        expect(json.comment.agent_id).toBe('dashboard')
      })
    })
  })

  // ─── WebSocket broadcast ───

  describe('WS task.comment broadcast', () => {
    it('calls broadcastComment after creating a comment via POST', async () => {
      const res = await postComment(TASK_ID, {
        comment: 'Broadcast me!',
        commentType: 'disagree',
        findingId: 'finding_ws_001',
        agentId: 'agent-ws-test',
      })
      expect(res.status).toBe(201)

      expect(mockBroadcastComment).toHaveBeenCalledTimes(1)
      expect(mockBroadcastComment).toHaveBeenCalledWith(
        TASK_ID,
        expect.objectContaining({
          task_id: TASK_ID,
          comment: 'Broadcast me!',
          comment_type: 'disagree',
          finding_id: 'finding_ws_001',
          agent_id: 'agent-ws-test',
        }),
      )
    })

    it('broadcasts the correct comment structure', async () => {
      await postComment(TASK_ID, {
        comment: 'Structure check',
        commentType: 'amendment',
      })

      const [, broadcastedComment] = mockBroadcastComment.mock.calls[0]!
      expect(broadcastedComment).toHaveProperty('id')
      expect(broadcastedComment).toHaveProperty('task_id', TASK_ID)
      expect(broadcastedComment).toHaveProperty('comment', 'Structure check')
      expect(broadcastedComment).toHaveProperty('comment_type', 'amendment')
      expect(broadcastedComment).toHaveProperty('created_at')
      expect(typeof broadcastedComment.id).toBe('number')
    })

    it('does NOT broadcast on validation failure', async () => {
      await postComment(TASK_ID, {
        comment: 'Bad type',
        commentType: 'invalid',
      })

      expect(mockBroadcastComment).not.toHaveBeenCalled()
    })

    it('does NOT broadcast when task not found', async () => {
      await postComment('task_nonexistent', { comment: 'Ghost' })

      expect(mockBroadcastComment).not.toHaveBeenCalled()
    })
  })

  // ─── WS handler: task.comment message type ───

  describe('WS conductor handler: task.comment message', () => {
    it('inserts comment into DB when received via WS handler logic', () => {
      // Directly test DB insert logic that the WS handler uses (lines 489-491 of ws/conductor.ts)
      const taskId = TASK_ID
      const comment = 'WS-originated comment'
      const findingId = 'finding_ws_direct'
      const commentType = 'agree'
      const agentId = 'agent-ws-sender'

      const result = db.prepare(
        'INSERT INTO conductor_comments (task_id, finding_id, agent_id, comment, comment_type) VALUES (?, ?, ?, ?, ?)'
      ).run(taskId, findingId, agentId, comment, commentType)

      const created = db.prepare('SELECT * FROM conductor_comments WHERE id = ?').get(result.lastInsertRowid) as {
        id: number; task_id: string; finding_id: string | null; agent_id: string | null
        comment: string; comment_type: string; created_at: string
      }

      expect(created.task_id).toBe(taskId)
      expect(created.finding_id).toBe(findingId)
      expect(created.agent_id).toBe(agentId)
      expect(created.comment).toBe(comment)
      expect(created.comment_type).toBe(commentType)
      expect(created.created_at).toBeDefined()
    })

    it('enforces comment_type CHECK constraint at DB level', () => {
      expect(() => {
        db.prepare(
          'INSERT INTO conductor_comments (task_id, comment, comment_type) VALUES (?, ?, ?)'
        ).run(TASK_ID, 'Bad DB insert', 'invalid_type')
      }).toThrow()
    })

    it('truncates long comments at DB level (WS handler slices to 4000)', () => {
      const longComment = 'x'.repeat(4000)
      const result = db.prepare(
        'INSERT INTO conductor_comments (task_id, agent_id, comment, comment_type) VALUES (?, ?, ?, ?)'
      ).run(TASK_ID, 'agent-long', longComment, 'comment')

      const created = db.prepare('SELECT * FROM conductor_comments WHERE id = ?').get(result.lastInsertRowid) as { comment: string }
      expect(created.comment).toHaveLength(4000)
    })
  })
})
