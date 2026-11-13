import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSaid } from '../doors.ts'
import { cpuSeconds, IDLE_MS, idleSaid, idleSince, look, treeOf, type Cpu, type Watch } from '../queue/idle.ts'
import { Queue } from '../queue/queue.ts'
import type { Spawner } from '../queue/runner.ts'

const cpu = (entries: [number, number][]): Cpu => new Map(entries)
const MIN = 60_000

/** The looks of a tree whose CPU grows by `rate` seconds of CPU per second, one look a minute. */
function looks(rates: number[], pids = [10, 11]): Watch {
  let watch: Watch | null = null
  let used = 0
  rates.forEach((rate, step) => {
    used += rate * 60
    watch = look(watch, cpu(pids.map((pid, at) => [pid, at === 0 ? used : 0])), step * MIN)
  })
  return watch!
}

describe('idle slots (issue #48)', () => {
  test('ps cputime, in seconds', () => {
    expect(cpuSeconds('0:00.12')).toBeCloseTo(0.12)
    expect(cpuSeconds('1:02.50')).toBeCloseTo(62.5)
    expect(cpuSeconds('1:02:03')).toBe(3723)
    expect(cpuSeconds('2-00:00:01')).toBe(172_801)
    expect(Number.isNaN(cpuSeconds('x'))).toBe(true)
  })
  test('a run\'s tree is its group and everything below it, nothing else', () => {
    const ps = ['100 1 100 0:00.01', '101 100 100 0:00.50', '102 101 102 0:01.00', '200 1 200 9:00.00', '103 102 102 0:00.10', ' bad line'].join('\n')
    expect([...treeOf(ps, 100).keys()].sort()).toEqual([100, 101, 102, 103])
  })
  test('quiet for the whole time: idle, and since when', () => {
    const watch = looks([0, 0, 0, 0, 0, 0, 0])
    expect(idleSince(watch, 6 * MIN)).toBe(0)
    expect(idleSince(watch, 6 * MIN, 10 * MIN)).toBeNull()
    expect(IDLE_MS).toBeGreaterThanOrEqual(3 * MIN)
  })
  test('not before it has been quiet for long enough', () => {
    expect(idleSince(looks([0, 0, 0]), 2 * MIN)).toBeNull()
  })
  test('working at any look ends it: a busy run is never flagged', () => {
    expect(idleSince(looks([0, 0, 0, 0.9, 0, 0]), 5 * MIN)).toBeNull()
    expect(idleSince(looks([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), 5 * MIN)).toBeNull()
  })
  test('a polling loop\'s short-lived sleeps are quiet: new processes that used next to nothing', () => {
    let watch: Watch | null = null
    for (let step = 0; step < 8; step++) watch = look(watch, cpu([[10, 0.5], [1000 + step, 0.01]]), step * MIN)
    expect(idleSince(watch, 7 * MIN)).toBe(0)
  })
  test('a new process that is busy is activity', () => {
    const was = look(null, cpu([[10, 1]]), 0)
    expect(look(was, cpu([[10, 1], [11, 30]]), MIN).quietSince).toBeNull()
  })
  test('the words say how long, and that the person can cancel; never that it was stopped', () => {
    const said = idleSaid(0, 7 * MIN)
    expect(said).toContain('Idle in its slot')
    expect(said).toContain('7 min')
    expect(said).toContain('Cancel it')
  })
})

describe('the queue flags an idle run, and does not touch it', () => {
  const made: string[] = []
  let q: Queue | null = null
  afterEach(() => {
    q?.stop()
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('a running run whose tree is quiet is flagged in its view and in queue_status; it keeps running, and a busy one is not flagged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-idle-'))
    made.push(dir)
    let now = 1_000_000
    const hold: Spawner = { start: ({ exit }) => ({ pid: process.pid, exited: new Promise<number>(() => void exit) }) }
    /* One run is the test process itself (alive, so the queue does not call it ended); its CPU is whatever the test says. */
    let used = 0
    q = new Queue({
      dir,
      capacity: () => ({ most: 2, loadAbove: 100, waitMs: 600_000 }),
      load: () => 0,
      clock: () => now,
      spawner: hold,
      idleMs: 3 * MIN,
      sampler: async (roots) => new Map(roots.map((root) => [root, cpu([[root, used]])])),
    })
    const run = q.enqueue({ argv: ['x'], cwd: tmpdir(), env: {}, kind: 'verify', label: 'waits', refs: [], epic: null, project: null, asker: { via: 'cli', said: 'a test', token: null, conversation: null } })
    expect(run.state).toBe('running')
    const step = async () => {
      now += MIN
      q!.tick()
      await Bun.sleep(5)
    }
    for (let i = 0; i < 5; i++) await step()
    const view = q.view(q.get(run.id)!)
    expect(view.state).toBe('running')
    expect(view.idleSince).not.toBeNull()
    expect(runSaid(view)).toContain('Idle in its slot')
    /* It works again: the flag goes. */
    used += 120
    await step()
    expect(q.view(q.get(run.id)!).idleSince).toBeNull()
    expect(q.get(run.id)!.state).toBe('running')
  })
})
