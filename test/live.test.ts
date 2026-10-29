import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'

import { watching } from 'kehikot-module-protocol/serve'

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { DIR, mcp, stream, toldOf, useQueue } from '../doors.ts'
import { Queue } from '../queue/queue.ts'
import { NEWS, OUTPUT_EVENTS, RUNS_EVENTS, RUNS_TOPIC, forgetSaid, outputTopic, stopWatching, waitingMoved } from '../live.ts'

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
  test('opens with the news, and tells that run’s page when its log grows: seen by the file’s watch, or at the queue’s next look', async () => {
    const ran = await call('queue_run', { command: ['sh', '-c', 'echo one; sleep 1.5; echo two; sleep 1.5'], cwd: tmpdir() })
    const id = /Queued (r[0-9a-z]+)/.exec(ran)![1]!
    const page = open(OUTPUT_EVENTS, `id=${id}`)
    const other = open(OUTPUT_EVENTS, 'id=r-someone-else')
    expect(page.heard).toEqual([NEWS])
    expect(watching(outputTopic(id))).toBe(1)
    await settle(300)
    forgetSaid()
    const base = page.heard.length

    /* Somebody appending to the log (open, write, close): the file's own watch tells. */
    appendFileSync(join(DIR, 'logs', `${id}.log`), 'a line\n')
    await settle()
    expect(page.heard.length).toBe(base + 1)

    /* The run's own process writing "two" through the descriptor it holds, which Bun's watch is not
       told of: the queue's next look (`tick`, every 5 s in the module) notices the log grew. */
    queue().tick()
    await settle(1700)
    forgetSaid()
    const before = page.heard.length
    queue().tick()
    await settle()
    /* Exactly one piece of news for "two", however many events the file system sent. */
    expect(page.heard.length).toBe(before + 1)
    expect(other.heard).toEqual([NEWS])

    page.close()
    other.close()
    expect(watching(outputTopic(id))).toBe(0)
    await queue().wait(id, 5000)
  })

  test('the queue’s look tells of a log that grew with no watch told, and nothing when it did not grow', async () => {
    const ran = await call('queue_run', { command: ['sh', '-c', 'sleep 3'], cwd: tmpdir() })
    const id = /Queued (r[0-9a-z]+)/.exec(ran)![1]!
    const page = open(OUTPUT_EVENTS, `id=${id}`)
    await settle(300)
    forgetSaid()
    stopWatching()
    /* No watch at all now: only the look can tell. Following again, without a watch made. */
    const again = open(OUTPUT_EVENTS, `id=${id}`)
    stopWatching()
    const followedAgain = open(OUTPUT_EVENTS, `id=${id}`)
    const base = followedAgain.heard.length
    queue().tick()
    await settle()
    expect(followedAgain.heard.length).toBe(base)
    page.close()
    again.close()
    followedAgain.close()
    await queue().wait(id, 5000)
  })

  test('another path, or no run, is not a stream', () => {
    expect(stream('GET', '/api/runs', new URLSearchParams(), () => {}, null)).toBeNull()
    expect(stream('GET', OUTPUT_EVENTS, new URLSearchParams(), () => {}, null)).toBeNull()
  })
})
