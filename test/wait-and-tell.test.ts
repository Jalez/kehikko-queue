import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LIMITS } from 'kehikot-module-protocol'
import { beforeInfo } from 'kehikot-module-protocol/serve'

import { follow, parse } from '../bin/kehikot-queue.ts'
import { ASK, mcp, noticeFor, progressSaid, span, tellAsker, tools, waitLine, waitSaid, waitTelling } from '../doors.ts'
import { cliDoor, TOKEN_HEADER, type CliDoorOptions } from '../queue/cli-door.ts'
import { checkFolder, hasMiseConfig, nodeModulesSaid, preflightRefusal, signatureOf, untrustedOf } from '../queue/preflight.ts'
import { Queue, type Ask, type Run } from '../queue/queue.ts'
import { CLI, fill, skillTemplate } from '../skills.ts'

/*
 * Issue #27: waiting on a run as long as it takes (`kehikot-queue wait`, progress on queue_wait).
 * Issue #28: a folder that is not ready is said when the run is asked for, not after the wait.
 * Protocol #106: when nothing waits on a run as it ends, the session that asked is told.
 */

const TOKEN = 'A'.repeat(43)
const PLACE = 'P'.repeat(32)
const made: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-wait-'))
  made.push(dir)
  return dir
}
let q: Queue
let ended: Array<{ id: string; watched: boolean }>
beforeEach(() => {
  ended = []
  q = new Queue({ dir: scratch(), capacity: () => ({ most: 2, loadAbove: 100, waitMs: 600_000 }), load: () => 0, ended: (run, watched) => ended.push({ id: run.id, watched }) })
})
afterEach(() => {
  q.stop()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  ASK.options = {}
})

const ask = (argv: string[], over: Partial<Ask> = {}): Ask => ({
  argv,
  cwd: tmpdir(),
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  kind: 'verify',
  label: 'unit',
  refs: [],
  epic: null,
  project: null,
  asker: { via: 'mcp', said: 'a test', token: PLACE, conversation: 'c1' },
  ...over,
})

describe('the queue says when a run ends, and whether anyone waited on it', () => {
  test('nobody waiting: told unwatched, once', async () => {
    const run = q.enqueue(ask(['sh', '-c', 'exit 0']))
    await q.wait(run.id, 5000)
    expect(ended).toEqual([{ id: run.id, watched: false }])
  })
  test('a watcher at the end: told watched; released, unwatched', async () => {
    const one = q.enqueue(ask(['sh', '-c', 'sleep 0.3']))
    const release = q.watch(one.id)
    await q.wait(one.id, 5000)
    release()
    release()
    const two = q.enqueue(ask(['sh', '-c', 'sleep 0.3']))
    const gone = q.watch(two.id)
    gone()
    await q.wait(two.id, 5000)
    expect(ended).toEqual([{ id: one.id, watched: true }, { id: two.id, watched: false }])
  })
  test('the asker’s own cancel is not news; the person’s is', () => {
    const held = new Queue({ dir: scratch(), capacity: () => ({ most: 0, loadAbove: 100, waitMs: 600_000 }), load: () => 0, ended: (run, watched) => ended.push({ id: run.id, watched }) })
    const mine = held.enqueue(ask(['true']))
    const theirs = held.enqueue(ask(['true']))
    held.cancel(mine.id, { token: PLACE })
    held.cancel(theirs.id, { person: true })
    held.stop()
    expect(ended.map((one) => one.id)).toEqual([theirs.id])
  })
})

describe('a fast failure that shows the folder, not the work (#28)', () => {
  test('signatures', () => {
    expect(signatureOf('mise ERROR Config files in ~/w/mise.toml are not trusted.')).toContain('mise trust')
    expect(signatureOf("error: Cannot find module 'katex'")).toContain('dependencies')
    expect(signatureOf('sh: vitest: command not found')).toContain('not found in the run')
    expect(signatureOf('1 test failed: expected 2, got 3')).toBeNull()
  })
  test('a run that fails at once with one says what to fix', async () => {
    const run = q.enqueue(ask(['sh', '-c', 'echo "error: Cannot find module \'katex\'" >&2; exit 1']))
    const done = (await q.wait(run.id, 5000))!
    expect(done.state).toBe('failed')
    expect(done.why).toContain('looks like the folder, not the work')
    expect(done.why).toContain('install this folder')
  })
  test('an ordinary failure keeps no such words', async () => {
    const run = q.enqueue(ask(['sh', '-c', 'echo "expected 2, got 3"; exit 1']))
    expect((await q.wait(run.id, 5000))!.why).toBeNull()
  })
})

describe('is the folder ready (#28)', () => {
  test('preflight: a pass is nothing; a failure refuses with its output', async () => {
    expect(await preflightRefusal(['sh', '-c', 'exit 0'], tmpdir(), { PATH: process.env.PATH! })).toBeNull()
    const refused = await preflightRefusal(['sh', '-c', 'echo lockfile is stale; exit 3'], tmpdir(), { PATH: process.env.PATH! })
    expect(refused).toContain('failed (exit 3)')
    expect(refused).toContain('lockfile is stale')
    expect(await preflightRefusal(['sh', '-c', 'sleep 5'], tmpdir(), { PATH: process.env.PATH! }, 200)).toContain('did not finish')
  })
  test('mise: a config file in the folder or above it, not the home folder’s own', () => {
    const home = scratch()
    const work = join(home, 'w', 'repo')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(home, 'mise.toml'), '')
    expect(hasMiseConfig(work, home)).toBe(false)
    writeFileSync(join(home, 'w', '.mise.toml'), '')
    expect(hasMiseConfig(work, home)).toBe(true)
    expect(untrustedOf('~/w/.mise.toml: untrusted\n~/w/repo/mise.toml: trusted\n')).toEqual(['~/w/.mise.toml'])
  })
  test('mise untrusted refuses; trusted does not', async () => {
    const home = scratch()
    const work = join(home, 'repo')
    mkdirSync(work)
    writeFileSync(join(work, 'mise.toml'), '')
    const bin = scratch()
    const mise = join(bin, 'mise')
    writeFileSync(mise, '#!/bin/sh\necho "$PWD/mise.toml: untrusted"\n')
    chmodSync(mise, 0o755)
    const checked = await checkFolder(work, { PATH: process.env.PATH! }, { home, mise })
    expect(checked.refuse[0]).toContain('mise does not trust')
    expect(checked.refuse[0]).toContain('mise trust')
    writeFileSync(mise, '#!/bin/sh\necho "$PWD/mise.toml: trusted"\n')
    expect((await checkFolder(work, { PATH: process.env.PATH! }, { home, mise })).refuse).toEqual([])
    /* No mise installed: nothing to ask. */
    expect((await checkFolder(work, { PATH: process.env.PATH! }, { home, mise: null })).refuse).toEqual([])
  })
  test('node_modules missing or older than the lockfile is said; newer is fine; no JS project, nothing', () => {
    const work = scratch()
    expect(nodeModulesSaid(work)).toBeNull()
    writeFileSync(join(work, 'package.json'), '{}')
    writeFileSync(join(work, 'bun.lock'), '')
    expect(nodeModulesSaid(work)).toContain('no node_modules')
    mkdirSync(join(work, 'node_modules'))
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(join(work, 'node_modules'), old, old)
    expect(nodeModulesSaid(work)).toContain('older than bun.lock')
    writeFileSync(join(work, 'node_modules', '.bun-tag'), '')
    expect(nodeModulesSaid(work)).toBeNull()
  })
})

const call = async (name: string, args: Record<string, unknown>, query = '') => {
  const reply = await mcp({ id: 1, method: 'tools/call', params: { name, arguments: args } }, new URLSearchParams(query), q)
  const result = (reply.body as { result: { content: { text: string }[]; isError?: boolean } }).result
  return { text: result.content[0]!.text, error: result.isError === true }
}

const placeFetch = (async (url: string | URL | Request) => {
  if (String(url).includes('/host/place')) {
    return Response.json({ ok: true, place: { token: PLACE, conversation: 'abcdef123456', projectId: 'project-scratch-1', project: tmpdir(), projectName: 'Scratch', epic: 'queue', parts: [], kehikko: { key: 'k1', name: 'Wide' } } })
  }
  return new Response('no', { status: 404 })
}) as typeof fetch

describe('queue_run answers how to wait as long as it takes (#27)', () => {
  test('the wait line, as a background command, and the notice when placed', async () => {
    ASK.options = { fetch: placeFetch, env: { KEHIKOT_ORIGINS: 'http://127.0.0.1:9' } }
    const ran = await call('queue_run', { command: ['sh', '-c', 'exit 0'], cwd: tmpdir(), label: 'unit' }, `kehikot-place=${PLACE}`)
    const id = /Queued (r[0-9a-z]+)/.exec(ran.text)![1]!
    expect(ran.text).toContain(waitLine(id))
    expect(ran.text).toContain('run_in_background')
    expect(ran.text).toContain(`queue_wait with id ${id}`)
    expect(ran.text).toContain('Kehikot types a one-line notice')
    await q.wait(id, 5000)
  })
  test('without a place there is no notice to promise', () => {
    expect(waitSaid('r1', false).join('\n')).not.toContain('notice')
  })
  test('the wait line quotes a path with spaces for the shell', () => {
    expect(waitLine('r1')).toMatch(/ wait r1$/)
    if (CLI.includes(' ')) expect(waitLine('r1').startsWith("'")).toBe(true)
  })
  test('a failing preflight is refused at once and never queued', async () => {
    const ran = await call('queue_run', { command: ['true'], cwd: tmpdir(), preflight: ['sh', '-c', 'echo not ready; exit 4'] })
    expect(ran.error).toBe(true)
    expect(ran.text).toContain('not ready')
    expect(q.list()).toEqual([])
  })
  test('a stale node_modules is said as "Would fail", and the run is queued anyway', async () => {
    const work = scratch()
    writeFileSync(join(work, 'package.json'), '{}')
    writeFileSync(join(work, 'bun.lock'), '')
    const ran = await call('queue_run', { command: ['true'], cwd: work })
    expect(ran.error).toBe(false)
    expect(ran.text).toContain('Would fail: there is no node_modules')
    expect(q.list()).toHaveLength(1)
    await q.wait(q.list()[0]!.id, 5000)
  })
  test('the tools say it', () => {
    const run = tools().find((one) => one.name === 'queue_run')!
    expect(run.description).toContain('BACKGROUND')
    expect(Object.keys(run.inputSchema.properties)).toEqual(expect.arrayContaining(['preflight', 'checks']))
    expect(tools().find((one) => one.name === 'queue_wait')!.description).toContain('progress')
  })
})

describe('queue_wait, streamed: progress, and the watch ends with the caller (#27)', () => {
  const door = (over: Partial<CliDoorOptions> = {}) =>
    cliDoor({ queue: () => q, token: () => TOKEN, everyMs: 50, mcp: (rpc, query, tick) => mcp(rpc, query, q, tick), ...over })
  const post = (body: unknown, accept: string) => {
    const request = new Request('http://127.0.0.1:8110/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept }, body: JSON.stringify(body) })
    return door()(request, beforeInfo(request))
  }

  test('with a progressToken and server-sent events: progress, then the result', async () => {
    const run = q.enqueue(ask(['sh', '-c', 'sleep 0.4; echo done']))
    const got = (await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'queue_wait', arguments: { id: run.id, timeout_seconds: 10 }, _meta: { progressToken: 'p1' } } }, 'application/json, text/event-stream'))!
    expect(got.headers.get('content-type')).toBe('text/event-stream')
    const events = (await got.text()).split('\n\n').filter(Boolean).map((one) => JSON.parse(one.replace(/^event: message\ndata: /, '')))
    const last = events.at(-1)
    expect(last).toMatchObject({ jsonrpc: '2.0', id: 7 })
    expect(last.result.content[0].text).toContain('passed')
    expect(ended).toEqual([{ id: run.id, watched: true }])
  })
  test('progress is said while it waits, where the run stands', async () => {
    const run = q.enqueue(ask(['sh', '-c', 'sleep 0.4']))
    const ticks: string[] = []
    await waitTelling(q, run.id, 10_000, (said) => ticks.push(said), 50)
    expect(ticks.length).toBeGreaterThan(1)
    expect(ticks[0]).toMatch(/^Running for \d+ s\.$/)
    expect(progressSaid({ ...q.view(q.get(run.id)!), state: 'running', startedAt: 1000 }, 5000)).toBe('Running for 4 s.')
  })
  test('without server-sent events: the one JSON answer', async () => {
    const run = q.enqueue(ask(['sh', '-c', 'exit 2']))
    const got = (await post({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'queue_wait', arguments: { id: run.id, timeout_seconds: 10 } } }, 'application/json'))!
    const body = (await got.json()) as { id: number; result: { content: { text: string }[] } }
    expect(body.id).toBe(8)
    expect(body.result.content[0]!.text).toContain('failed, exit 2')
  })
  test('another tool goes on to the doors', async () => {
    expect(await post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'queue_status', arguments: {} } }, 'application/json')).toBeUndefined()
  })
  test('a caller that goes away ends the wait and the watch, so the end is told as a notice', async () => {
    const run = q.enqueue(ask(['sh', '-c', 'sleep 0.6']))
    const quick = cliDoor({
      queue: () => q,
      token: () => TOKEN,
      mcp: async (_rpc, _query, tick) => {
        const release = q.watch(run.id)
        try {
          await waitTelling(q, run.id, 10_000, tick, 50)
        } finally {
          release()
        }
        return { status: 200, body: {} }
      },
    })
    const request = new Request('http://127.0.0.1:8110/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'queue_wait', arguments: { id: run.id }, _meta: { progressToken: 1 } } }),
    })
    const got = (await quick(request, beforeInfo(request)))!
    await new Promise((done) => setTimeout(done, 100))
    await got.body!.cancel()
    await q.wait(run.id, 5000)
    expect(ended).toEqual([{ id: run.id, watched: false }])
  })
})

describe('the CLI follow is a watch (#27, #106)', () => {
  test('a run followed to its end is told watched', async () => {
    const run = q.enqueue(ask(['sh', '-c', 'sleep 0.2; echo hi']))
    const request = new Request(`http://127.0.0.1:8110/api/queue/follow?id=${run.id}`, { headers: { [TOKEN_HEADER]: TOKEN } })
    const got = (await cliDoor({ queue: () => q, token: () => TOKEN, everyMs: 50 })(request, beforeInfo(request)))!
    await got.text()
    expect(ended).toEqual([{ id: run.id, watched: true }])
  })
})

describe('kehikot-queue wait and its flags (#27, #28)', () => {
  test('parse --preflight and --no-checks', () => {
    const parsed = parse(['--preflight', 'bun install --dry-run', '--no-checks', '--', 'bun', 'test'])
    expect(parsed).toMatchObject({ preflight: ['/bin/sh', '-c', 'bun install --dry-run'], checks: false, argv: ['bun', 'test'] })
    expect(parse(['--preflight', '', '--', 'x'])).toContain('--preflight takes')
  })
  test('follow, as wait does it: the run’s own exit code, and nothing run instead', async () => {
    const run = q.enqueue(ask(['sh', '-c', 'echo out; exit 5']))
    const door = cliDoor({ queue: () => q, token: () => TOKEN, everyMs: 50 })
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async (request) => (await door(request, beforeInfo(request))) ?? new Response('no', { status: 404 }) })
    try {
      const url = `http://127.0.0.1:${server.port}`
      expect(await follow(url, TOKEN, run.id, { expect: null, instead: null })).toBe(5)
      expect(await follow(url, TOKEN, 'rnope', { expect: null, instead: null })).toBe(2)
    } finally {
      server.stop(true)
    }
  })
  test('the CLI door refuses a run whose preflight fails, marked so the CLI does not run it instead', async () => {
    const request = new Request('http://127.0.0.1:8110/api/queue/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ argv: ['true'], cwd: tmpdir(), env: { PATH: process.env.PATH }, preflight: ['sh', '-c', 'echo nope; exit 1'] }),
    })
    const got = (await cliDoor({ queue: () => q, token: () => TOKEN })(request, beforeInfo(request)))!
    expect(got.status).toBe(422)
    expect(await got.json()).toMatchObject({ ok: false, refused: true })
    expect(q.list()).toEqual([])
  })
})

describe('telling the session that asked (protocol 2.54.0)', () => {
  const ranRun = (over: Partial<Run> = {}): Run => ({
    id: 'r1', key: 'k', label: 'kehikko main', kind: 'verify', refs: [], epic: null, project: null, argv: ['bun', 'test'], cwd: '/work/kehikko',
    asker: { via: 'mcp', said: 'a session', token: PLACE, conversation: 'c1' }, origin: null, state: 'passed', why: null, pri: 0, rank: 0,
    queuedAt: 0, startedAt: 10_000, finishedAt: 262_000, exit: 0, pid: null, overdue: false, expect: null, ...over,
  })
  test('one line from the run’s own fields', () => {
    expect(noticeFor(ranRun())).toBe('Run "kehikko main" passed (exit 0) after 4 min 12 s — in /work/kehikko. Its output: queue_status or queue_wait with id r1.')
    expect(noticeFor(ranRun({ state: 'failed', exit: 1, expect: 'fail' }))).toContain('failed (exit 1), as expected')
    expect(noticeFor(ranRun({ state: 'cancelled', exit: null, startedAt: null, why: 'Cancelled by the person.' }))).toBe('Run "kehikko main" was cancelled — in /work/kehikko. Cancelled by the person. Its output: queue_status or queue_wait with id r1.')
    expect(noticeFor(ranRun({ state: 'failed', why: 'x'.repeat(5000) })).length).toBeLessThanOrEqual(LIMITS.MESSAGE_BODY)
    expect(span(38_000)).toBe('38 s')
    expect(span(120_000)).toBe('2 min')
  })
  test('asks the host to notify the asker’s token; skips when watched or unplaced', async () => {
    const asked: Array<{ method: string; params: Record<string, unknown> }> = []
    const fake = (async (method: string, params: Record<string, unknown>) => {
      asked.push({ method, params })
      return { ok: true, data: { outcome: 'sent', id: 1, why: '' } }
    }) as never
    expect(await tellAsker(ranRun(), false, fake)).toBe('told')
    expect(asked[0]).toMatchObject({ method: 'messages.notify', params: { token: PLACE, kind: 'report' } })
    expect(String(asked[0]!.params.body)).toContain('passed (exit 0)')
    expect(await tellAsker(ranRun(), true, fake)).toBe('skipped')
    expect(await tellAsker(ranRun({ asker: { via: 'cli', said: 'a shell', token: null, conversation: null } }), false, fake)).toBe('skipped')
    expect(asked).toHaveLength(1)
  })
  test('a host too old, or none, is quiet', async () => {
    const old = (async () => ({ ok: false, why: 'too old', declined: 'host-too-old' })) as never
    expect(await tellAsker(ranRun(), false, old)).toBe('refused')
    const throws = (async () => {
      throw new Error('boom')
    }) as never
    expect(await tellAsker(ranRun(), false, throws)).toBe('refused')
  })
})

describe('the skill', () => {
  test('tells a Claude Code agent to wait with the CLI as a background command, and may run only its wait', () => {
    const { text } = fill(skillTemplate('queue')!, 'http://127.0.0.1:9573')
    expect(text).toContain(`Bash('${CLI}' wait:*)`)
    expect(text).toContain('run_in_background: true')
    expect(text).toContain(`'${CLI}' wait <id>`)
    expect(text).not.toContain('{{cli}}')
  })
})
