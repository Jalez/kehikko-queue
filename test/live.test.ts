import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'

import { watching } from 'kehikot-module-protocol/serve'

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { DIR, mcp, stream, toldOf, useQueue } from '../doors.ts'
import { Queue } from '../queue/queue.ts'
import { NEWS, OUTPUT_EVENTS, RUNS_EVENTS, RUNS_TOPIC, forgetSaid, statTimers, stopWatching, useWatches, waitingMoved } from '../live.ts'

/**
 * The server's side of "the page never polls": the streams, called as the doors call them, with an
 * `emit` that collects what a page would hear, while the real change paths run — the MCP tools on
 * a queue told as this module's own is (`toldOf`), with room whatever this machine's load, a run's
 * own process writing its log, and a run finishing.
 */

/* This module's own queue folder (a scratch one, `setup.ts`): the stream watches its logs. */
let held: Queue | null = null
const queue = () => {
  if (!held) {
    held = new Queue({ dir: DIR, capacity: () => ({ most: 4, loadAbove: 1000, waitMs: 600_000 }), load: () => 0, ...toldOf(() => held) })
    /* The doors' own `queue()` is this one, so the stream finds its runs. */
    useQueue(held)
  }
  return held
}

const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms))

const open = (path: string, query = '') => {
  const heard: unknown[] = []
  const opened = stream('GET', path, new URLSearchParams(query), (event) => heard.push(event), null)
  if (!opened || !('close' in opened)) throw new Error(`${path} is not a stream`)
  return { heard, close: opened.close }
}

const call = async (name: string, args: Record<string, unknown>) => {
  const reply = await mcp({ id: 1, method: 'tools/call', params: { name, arguments: args } }, new URLSearchParams(), queue())
  return (reply.body as { result: { content: { text: string }[] } }).result.content[0]!.text
}

afterEach(() => {
  stopWatching()
  forgetSaid()
})
afterAll(() => {
  queue().stop()
  useQueue(null)
})

describe('the queue stream', () => {
  test('opens with the news once, then news when queue_run asks, when the run ends, and when queue_cancel cancels', async () => {
    const page = open(RUNS_EVENTS)
    expect(page.heard).toEqual([NEWS])
    expect(watching(RUNS_TOPIC)).toBe(1)

    const ran = await call('queue_run', { command: ['sh', '-c', 'sleep 0.3'], cwd: tmpdir(), label: 'short' })
    const id = /Queued (r[0-9a-z]+)/.exec(ran)![1]!
    await settle()
    /* Asked for and started in one breath: one piece of news. */
    expect(page.heard.length).toBe(2)

    await queue().wait(id, 5000)
    await settle()
    expect(queue().get(id)?.state).toBe('passed')
    expect(page.heard.length).toBe(3)

    const long = await call('queue_run', { command: ['sh', '-c', 'sleep 5'], cwd: tmpdir() })
    const [, longId, key] = /Queued (r[0-9a-z]+) \(key ([A-Za-z0-9_-]+)\)/.exec(long)!
    await settle()
    const before = page.heard.length
    expect(await call('queue_cancel', { id: longId, key })).toContain('Cancelled')
    await settle()
    expect(page.heard.length).toBe(before + 1)

    page.close()
    expect(watching(RUNS_TOPIC)).toBe(0)
  })

  test('nothing changing says nothing: no news on a clock', async () => {
    const page = open(RUNS_EVENTS)
    await settle(1000)
    expect(page.heard).toEqual([NEWS])
    page.close()
  })

  test('the queue’s look at the load tells the page only when what a waiting run says has moved', async () => {
    const page = open(RUNS_EVENTS)
    waitingMoved(() => 'Next: the machine’s load is 9.1, above 8.0')
    await settle()
    expect(page.heard.length).toBe(2)
    waitingMoved(() => 'Next: the machine’s load is 9.1, above 8.0')
    await settle()
    expect(page.heard.length).toBe(2)
    waitingMoved(() => 'Next: the machine’s load is 7.2, above 8.0')
    await settle()
    expect(page.heard.length).toBe(3)
    page.close()
  })
})

describe('a run’s output stream', () => {
  test('the file’s watch tells of an append at once', async () => {
    const ran = await call('queue_run', { command: ['sh', '-c', 'sleep 2'], cwd: tmpdir() })
    const id = /Queued (r[0-9a-z]+)/.exec(ran)![1]!
    const page = open(OUTPUT_EVENTS, `id=${id}`)
    const other = open(OUTPUT_EVENTS, 'id=r-someone-else')
    expect(page.heard).toEqual([NEWS])
    await settle(300)
    forgetSaid()
    const base = page.heard.length
    appendFileSync(join(DIR, 'logs', `${id}.log`), 'a line\n')
    await settle()
    expect(page.heard.length).toBe(base + 1)
    expect(other.heard).toEqual([NEWS])
    page.close()
    other.close()
    await queue().wait(id, 5000)
  })

  test('where the watch is never told (Bun), the run’s own printing still arrives within a second, once', async () => {
    useWatches(false)
    try {
      const ran = await call('queue_run', { command: ['sh', '-c', 'sleep 0.6; echo two; sleep 2.5'], cwd: tmpdir() })
      const id = /Queued (r[0-9a-z]+)/.exec(ran)![1]!
      const page = open(OUTPUT_EVENTS, `id=${id}`)
      expect(page.heard).toEqual([NEWS])
      const base = page.heard.length
      /* "two" lands at 0.6 s; within about a second of it the page is told, with nothing asked by a page. */
      await settle(600 + 1100)
      expect(page.heard.length).toBe(base + 1)
      /* Nothing more is printed: nothing more is said. */
      await settle(1000)
      expect(page.heard.length).toBe(base + 1)
      page.close()
      await queue().wait(id, 5000)
    } finally {
      useWatches(true)
    }
  })

  test('no size look runs while nobody follows; it stops when the last stream closes, and when the run ends', async () => {
    expect(statTimers()).toBe(0)
    const ran = await call('queue_run', { command: ['sh', '-c', 'sleep 1'], cwd: tmpdir() })
    const id = /Queued (r[0-9a-z]+)/.exec(ran)![1]!
    expect(statTimers()).toBe(0)

    const one = open(OUTPUT_EVENTS, `id=${id}`)
    const two = open(OUTPUT_EVENTS, `id=${id}`)
    expect(statTimers()).toBe(1)
    one.close()
    expect(statTimers()).toBe(1)
    two.close()
    expect(statTimers()).toBe(0)

    /* Followed until it ends: the look stops by itself. */
    const page = open(OUTPUT_EVENTS, `id=${id}`)
    expect(statTimers()).toBe(1)
    await queue().wait(id, 5000)
    await settle(1000)
    expect(statTimers()).toBe(0)
    page.close()

    /* A run that is not running (or not there) gets no look at all. */
    const gone = open(OUTPUT_EVENTS, 'id=r-not-a-run')
    expect(statTimers()).toBe(0)
    gone.close()
  })

  test('another path, or no run, is not a stream', () => {
    expect(stream('GET', '/api/runs', new URLSearchParams(), () => {}, null)).toBeNull()
    expect(stream('GET', OUTPUT_EVENTS, new URLSearchParams(), () => {}, null)).toBeNull()
  })
})
