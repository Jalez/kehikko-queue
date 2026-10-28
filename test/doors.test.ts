import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeInfo } from 'kehikot-module-protocol/serve'

import { ASK, TICKET, answer, mcp, mcpAsker, tools } from '../doors.ts'
import { cliDoor, TOKEN_HEADER } from '../queue/cli-door.ts'
import { Queue } from '../queue/queue.ts'

const TOKEN = 'A'.repeat(43)
let dir = ''
let q: Queue
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queue-doors-'))
  q = new Queue({ dir, capacity: () => ({ most: 2, loadAbove: 100, waitMs: 600_000 }), load: () => 0 })
})
afterEach(() => {
  q.stop()
  rmSync(dir, { recursive: true, force: true })
  ASK.options = {}
})

const door = () => cliDoor({ queue: () => q, token: () => TOKEN, everyMs: 50 })
const ask = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
  const request = new Request(`http://127.0.0.1:8110${path}`, init)
  return door()(request, beforeInfo(request))
}
const runBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ argv: ['sh', '-c', 'echo hi; sleep 1; exit 3'], cwd: tmpdir(), env: { PATH: process.env.PATH }, kind: 'push', label: 'pre-push', ...over })

describe('the CLI door refuses what is not a program of this user', () => {
  test('a page, of any origin, even this module\'s own', async () => {
    for (const origin of ['http://evil.example', 'http://127.0.0.1:8110']) {
      const answer = await ask('/api/queue/run', { method: 'POST', headers: { origin, 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN }, body: runBody() })
      expect(answer?.status).toBe(403)
    }
    const fetched = await ask('/api/queue/run', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN }, body: runBody() })
    expect(fetched?.status).toBe(403)
    expect(q.list()).toHaveLength(0)
  })
  test('a program without the token, or with another', async () => {
    for (const headers of [{}, { [TOKEN_HEADER]: 'B'.repeat(43) }] as Record<string, string>[]) {
      const answer = await ask('/api/queue/run', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: runBody() })
      expect(answer?.status).toBe(403)
      expect(((await answer!.json()) as { error: string }).error).toContain('token')
    }
    expect(q.list()).toHaveLength(0)
  })
  test('a body that is not JSON, or a command that is not an argv', async () => {
    expect((await ask('/api/queue/run', { method: 'POST', headers: { 'content-type': 'text/plain', [TOKEN_HEADER]: TOKEN }, body: runBody() }))?.status).toBe(400)
    expect((await ask('/api/queue/run', { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN }, body: runBody({ argv: 'rm -rf /' }) }))?.status).toBe(400)
    expect(q.list()).toHaveLength(0)
  })
  test('the agent door, POSTed from a page, is refused before the doors see it', async () => {
    const answer = await ask('/mcp', { method: 'POST', headers: { origin: 'http://127.0.0.1:8110', 'content-type': 'application/json' }, body: '{}' })
    expect(answer?.status).toBe(403)
    expect(await ask('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).toBeUndefined()
  })
})

describe('the CLI door, for the program that has the token', () => {
  test('queues, follows the output, and ends with the exit code', async () => {
    const queued = await ask('/api/queue/run', { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN }, body: runBody({ env: { PATH: process.env.PATH, GH_TOKEN: 'secret' } }) })
    const body = (await queued!.json()) as { id: string; key: string; dropped: string[] }
    expect(body.dropped).toEqual(['GH_TOKEN'])
    const follow = await ask(`/api/queue/follow?id=${body.id}`, { headers: { [TOKEN_HEADER]: TOKEN } })
    const lines = (await follow!.text()).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((one) => one.out).filter(Boolean).join('')).toBe('hi\n')
    expect(lines.at(-1).end).toMatchObject({ id: body.id, state: 'failed', exit: 3, kind: 'push', label: 'pre-push' })
  })
  test('cancels with the run\'s key, and only with it', async () => {
    const queued = await ask('/api/queue/run', { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN }, body: runBody({ argv: ['sh', '-c', 'sleep 5'] }) })
    const { id, key } = (await queued!.json()) as { id: string; key: string }
    const wrong = await ask('/api/queue/cancel', { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN }, body: JSON.stringify({ id, key: 'nope' }) })
    expect(wrong?.status).toBe(400)
    const right = await ask('/api/queue/cancel', { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN }, body: JSON.stringify({ id, key }) })
    expect(right?.status).toBe(200)
    expect(q.get(id)?.state).toBe('cancelled')
  })
})

const call = async (name: string, args: Record<string, unknown>, query = '') => {
  const reply = await mcp({ id: 1, method: 'tools/call', params: { name, arguments: args } }, new URLSearchParams(query), q)
  const result = (reply.body as { result: { content: { text: string }[]; isError?: boolean } }).result
  return { text: result.content[0]!.text, error: result.isError === true }
}

const PLACE = 'P'.repeat(32)
const placeFetch = (async (url: string | URL | Request) => {
  if (String(url).includes('/host/place')) {
    return Response.json({ ok: true, place: { token: PLACE, conversation: 'abcdef123456', projectId: 'project-scratch-1', project: tmpdir(), projectName: 'Scratch', epic: 'queue', parts: [], kehikko: { key: 'k1', name: 'Wide' } } })
  }
  return new Response('no', { status: 404 })
}) as typeof fetch

describe('the MCP door', () => {
  test('offers the four tools', () => {
    expect(tools().map((one) => one.name)).toEqual(['queue_run', 'queue_status', 'queue_wait', 'queue_cancel'])
  })
  test('queue_run takes the session and epic from its place; queue_wait answers the exit code and the output', async () => {
    ASK.options = { fetch: placeFetch, env: { KEHIKOT_ORIGINS: 'http://127.0.0.1:9' } }
    const ran = await call('queue_run', { command: ['sh', '-c', 'echo broken >&2; exit 2'], cwd: tmpdir(), kind: 'verify', label: 'unit', ref: '!3907' }, `kehikot-place=${PLACE}`)
    expect(ran.error).toBe(false)
    const id = /Queued (r[0-9a-z]+)/.exec(ran.text)![1]!
    const run = q.get(id)!
    expect(run.epic).toBe('queue')
    expect(run.refs).toEqual(['!3907'])
    expect(run.asker.said).toContain('Scratch › queue on "Wide"')
    const waited = await call('queue_wait', { id, timeout_seconds: 10 })
    expect(waited.text).toContain('failed, exit 2')
    expect(waited.text).toContain('broken')
    const status = await call('queue_status', {})
    expect(status.text).toContain('Finished lately (1)')
  })
  test('queue_cancel cancels only your own: by place, or by key', async () => {
    ASK.options = { fetch: placeFetch, env: { KEHIKOT_ORIGINS: 'http://127.0.0.1:9' } }
    const mine = await call('queue_run', { command: 'sleep 5', cwd: tmpdir() }, `kehikot-place=${PLACE}`)
    const id = /Queued (r[0-9a-z]+)/.exec(mine.text)![1]!
    expect((await call('queue_cancel', { id })).error).toBe(true)
    expect((await call('queue_cancel', { id }, `kehikot-place=${'Q'.repeat(32)}`)).error).toBe(true)
    expect((await call('queue_cancel', { id }, `kehikot-place=${PLACE}`)).text).toContain('Cancelled')
    const other = await call('queue_run', { command: ['sh', '-c', 'sleep 5'], cwd: tmpdir() })
    const [, otherId, key] = /Queued (r[0-9a-z]+) \(key ([A-Za-z0-9_-]+)\)/.exec(other.text)!
    expect((await call('queue_cancel', { id: otherId, key: key! })).text).toContain('Cancelled')
  })
  test('refuses a run with nowhere to run, or a ref that is not one', async () => {
    expect((await call('queue_run', { command: 'true' })).text).toContain('cwd')
    expect((await call('queue_run', { command: 'true', cwd: tmpdir(), ref: 'not a ref' })).error).toBe(true)
    expect((await call('queue_run', { command: [], cwd: tmpdir() })).error).toBe(true)
  })
  test('an asker with no place says so', () => {
    expect(mcpAsker(null, null).said).toBe('an agent session with no place')
  })
})

describe('the page\'s writes', () => {
  test('cancel and move need the page\'s ticket', async () => {
    const run = q.enqueue({ argv: ['sh', '-c', 'sleep 5'], cwd: tmpdir(), env: {}, kind: 'other', label: 'x', refs: [], epic: null, project: null, asker: { via: 'cli', said: 'a test', token: null, conversation: null } })
    const refused = await answer('POST', '/api/act', new URLSearchParams(), { op: 'cancel', id: run.id }, null, q)
    expect(refused?.status).toBe(403)
    const done = await answer('POST', '/api/act', new URLSearchParams(), { op: 'cancel', id: run.id }, TICKET, q)
    expect(done?.status).toBe(200)
    expect(q.get(run.id)?.state).toBe('cancelled')
  })
})
