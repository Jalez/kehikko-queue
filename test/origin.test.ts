import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeInfo } from 'kehikot-module-protocol/serve'

import { ASK, mcp } from '../doors.ts'
import { cliDoor, TOKEN_HEADER } from '../queue/cli-door.ts'
import { jumpFor, type Origin } from '../queue/origin.ts'
import { Queue } from '../queue/queue.ts'

const TOKEN = 'A'.repeat(43)
const PLACE = 'P'.repeat(32)
let root = ''
let dir = ''
let project = ''
let q: Queue
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-origin-')))
  dir = join(root, 'queue')
  project = join(root, 'proj')
  mkdirSync(join(project, 'packages', 'a'), { recursive: true })
  Bun.spawnSync(['git', 'init', '-q', '-b', 'feature-x', project])
  q = new Queue({ dir: (mkdirSync(dir), dir), capacity: () => ({ most: 0, loadAbove: 100, waitMs: 600_000 }), load: () => 0 })
})
afterEach(() => {
  q.stop()
  rmSync(root, { recursive: true, force: true })
  ASK.options = {}
})

/** A host that holds exactly `project` (when set) and knows the place token. */
const host = (held: string | null) =>
  (async (url: string | URL | Request) => {
    const href = String(url)
    if (href.includes('/host/is-project')) {
      const path = new URL(href).searchParams.get('path')
      return Response.json({ ok: true, project: held !== null && path === held })
    }
    if (href.includes('/host/place')) {
      return Response.json({ ok: true, place: { token: PLACE, conversation: 'abcdef123456', projectId: 'project-scratch-1', project, projectName: 'Scratch', epic: 'queue', parts: ['methods'], kehikko: { key: 'k1', name: 'Wide' } } })
    }
    return new Response('no', { status: 404 })
  }) as typeof fetch

const run = (name: string, args: Record<string, unknown>, query = '') =>
  mcp({ id: 1, method: 'tools/call', params: { name, arguments: args } }, new URLSearchParams(query), q)

const door = () => cliDoor({ queue: () => q, token: () => TOKEN, everyMs: 50, ask: () => ASK.options })
const cli = (body: Record<string, unknown>) => {
  const request = new Request('http://127.0.0.1:8110/api/queue/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN },
    body: JSON.stringify({ argv: ['true'], env: { PATH: process.env.PATH }, kind: 'push', label: 'hook', ...body }),
  })
  return door()(request, beforeInfo(request))
}

describe('a run records where it came from', () => {
  test('an MCP call with a place: its project, epic, parts, kehikko and session', async () => {
    ASK.options = { fetch: host(project), keepMs: 0 }
    await run('queue_run', { command: ['true'], label: 'unit', cwd: project }, `kehikot-place=${PLACE}`)
    const [one] = q.list()
    expect(one!.origin).toEqual({ project, projectId: 'project-scratch-1', projectName: 'Scratch', epic: 'queue', parts: ['methods'], kehikko: 'k1', kehikkoName: 'Wide', session: 'abcdef123456', branch: 'feature-x' })
  })

  test('a CLI run inside a project: the project the host names, found from a subfolder, with the branch', async () => {
    ASK.options = { fetch: host(project), keepMs: 0 }
    const answer = await cli({ cwd: join(project, 'packages', 'a') })
    expect(answer?.status).toBe(200)
    expect(q.list()[0]!.origin).toEqual({ project, projectId: null, projectName: 'proj', epic: null, parts: [], kehikko: null, kehikkoName: null, session: null, branch: 'feature-x' })
  })

  test('a CLI run outside any project: no origin, and nothing else of the caller kept', async () => {
    ASK.options = { fetch: host(null), keepMs: 0 }
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    await cli({ cwd: elsewhere, env: { PATH: process.env.PATH, SECRET_THING: 'x' } })
    const one = q.list()[0]!
    expect(one.origin).toBeNull()
    expect(JSON.stringify(one)).not.toContain('SECRET_THING')
  })
})

describe('the jump-into button, from the origin', () => {
  const origin: Origin = { project: '/p', projectName: 'Scratch', epic: 'queue', parts: ['p1', 'p2'], kehikko: 'k1', kehikkoName: 'Wide', session: 's1', branch: null }
  const base = { cwd: '/work/thing', project: '/p', epic: 'queue', origin }

  test('goes to the epic with the parts and the kehikko, and names them', () => {
    expect(jumpFor(base, '/p', (id) => ({ p1: 'methods', p2: 'results' })[id] ?? id)).toEqual({
      goto: { epic: 'queue', parts: ['p1', 'p2'], kehikko: 'k1', show: { subject: 'agent-session', id: 's1' } },
      words: 'Go to Wide · queue · methods, results',
    })
  })
  test('asks for only the epic when nothing more is known', () => {
    expect(jumpFor({ ...base, origin: { ...origin, parts: [], kehikko: null, kehikkoName: null, session: null } }, '/p').goto).toEqual({ epic: 'queue' })
  })
  test('outside any project: disabled, naming the folder', () => {
    expect(jumpFor({ cwd: '/Users/me/scratch/thing/', project: null, epic: null, origin: null }, '/p')).toEqual({ goto: null, words: 'Started outside any Kehikot project: thing' })
  })
  test('another project: the host switches to it, named by id when the run kept one, else by folder', () => {
    expect(jumpFor(base, '/other')).toEqual({
      goto: { epic: 'queue', parts: ['p1', 'p2'], kehikko: 'k1', project: '/p', show: { subject: 'agent-session', id: 's1' } },
      words: 'Go to Scratch · Wide · queue · p1, p2 (in another project)',
    })
    const withId = { ...base, origin: { ...origin, projectId: 'project-scratch-1' } }
    expect(jumpFor(withId, { path: '/elsewhere', id: 'project-other-2' }).goto?.project).toBe('project-scratch-1')
    expect(jumpFor(withId, { path: '/moved/p', id: 'project-scratch-1' }).goto?.project).toBeUndefined()
  })
  test('no project open, or no epic: disabled, with the reason', () => {
    expect(jumpFor(base, null).words).toContain('Open Test runs in Kehikot')
    expect(jumpFor(base, { path: null, id: null }).goto).toBeNull()
    expect(jumpFor({ ...base, origin: { ...origin, epic: null } }, '/p').words).toContain('not in an epic')
  })
  test('a run kept before origins were recorded still goes to its epic', () => {
    expect(jumpFor({ cwd: '/p', project: '/p', epic: 'queue' }, '/p').goto).toEqual({ epic: 'queue' })
  })
})
