import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { answer } from '../doors.ts'
import { Queue } from '../queue/queue.ts'
import { api } from '../src/wire/api.ts'

/**
 * The page's reads against the real server code (`answer`), through the page's own client: what crosses
 * the wire for a queue of 300 finished runs, as the person's queue is (issue: ~390 kB every 5 s).
 */
let dir = ''
let q: Queue
const wire: { path: string; bytes: number }[] = []
const realFetch = globalThis.fetch

const finished = (i: number) => ({
  id: `r${i}`, key: 'k', label: `bun test ${i}`, kind: 'verify', refs: [], epic: null, project: '/Users/someone/Projects/a-project',
  argv: ['bun', 'test'], cwd: '/Users/someone/Projects/a-project', asker: { name: 'a session', session: 'x'.repeat(60), note: 'y'.repeat(200) },
  origin: null, state: 'passed', why: null, pri: 0, rank: i, queuedAt: Date.now() - 400_000 + i * 100, startedAt: Date.now() - 399_000 + i * 100, finishedAt: Date.now() - 398_000 + i * 100, exit: 0, pid: 1, overdue: false,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'queue-wire-'))
  writeFileSync(join(dir, 'runs.json'), JSON.stringify({ version: 1, runs: Array.from({ length: 300 }, (_, i) => finished(i)) }))
  q = new Queue({ dir, capacity: () => ({ most: 2, loadAbove: 100, waitMs: 600_000 }), load: () => 0 })
  wire.length = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:1')
    const reply = await answer(init?.method ?? 'GET', url.pathname, url.searchParams, init?.body ? JSON.parse(String(init.body)) : null, null, q)
    const text = JSON.stringify(reply?.body ?? {})
    wire.push({ path: url.pathname + url.search, bytes: text.length })
    return new Response(text, { status: reply?.status ?? 404, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  q.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('the page reading a long queue', () => {
  test('the first read is the whole queue, every later one is small, and the page holds exactly the queue', async () => {
    const first = await api.runs()
    expect(first.runs).toHaveLength(300)
    expect(wire[0]!.bytes).toBeGreaterThan(200_000)

    /* Thirty reads over a minute of load changes and nothing else: the old page moved ~4.7 MB. */
    for (let i = 0; i < 30; i++) {
      const again = await api.runs()
      expect(again.runs.map((run) => run.id)).toEqual(first.runs.map((run) => run.id))
    }
    const later = wire.slice(1).reduce((sum, one) => sum + one.bytes, 0)
    expect(later).toBeLessThan(3000)
    expect(later).toBeLessThan(wire[0]!.bytes / 100)
  })

  test('a run asked for arrives alone, in its place', async () => {
    await api.runs()
    const before = wire.length
    q.enqueue({ argv: ['true'], cwd: tmpdir(), env: {}, kind: 'task', label: 'new one', refs: [], epic: null, project: null, asker: { name: 'a session' } as never })
    const got = await api.runs()
    expect(got.runs.some((run) => run.label === 'new one')).toBe(true)
    expect(got.runs.map((run) => run.id)).toEqual(q.list().map((run) => run.id))
    expect(got.runs).toHaveLength(301)
    expect(wire.slice(before).every((one) => one.bytes < 3000)).toBe(true)
  })
})
