import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { latestRuns } from 'kehikot-module-protocol'
import { readRuns } from 'kehikot-module-protocol/serve'

import { Queue, type Ask } from '../queue/queue.ts'
import { runEnv } from '../queue/env.ts'
import { publish } from '../store.ts'

/*
 * The queue with real processes: harmless shell commands, a scratch folder, and a capacity the test
 * sets. What is held here is that going through the queue changes nothing about a run's result.
 */
const made: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-'))
  made.push(dir)
  return dir
}
const queues: Queue[] = []
afterEach(() => {
  for (const q of queues.splice(0)) q.stop()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function queue(over: { most?: number; load?: number; loadAbove?: number; clock?: () => number; dir?: string; publish?: (project: string, runs: ReturnType<Queue['resultsFor']>) => void } = {}) {
  const q = new Queue({
    dir: over.dir ?? scratch(),
    capacity: () => ({ most: over.most ?? 2, loadAbove: over.loadAbove ?? 100, waitMs: 10 * 60_000 }),
    load: () => over.load ?? 0,
    ...(over.clock ? { clock: over.clock } : {}),
    ...(over.publish ? { publish: over.publish } : {}),
  })
  queues.push(q)
  return q
}

const ask = (argv: string[], over: Partial<Ask> = {}): Ask => ({
  argv,
  cwd: tmpdir(),
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  kind: 'verify',
  label: 'harmless',
  refs: [],
  epic: null,
  project: null,
  asker: { via: 'cli', said: 'a test', token: null, conversation: null },
  ...over,
})

describe('a run through the queue', () => {
  test('passes its exit code through unchanged, and keeps its output', async () => {
    const q = queue()
    const run = q.enqueue(ask(['sh', '-c', 'echo out; echo err >&2; sleep 1; exit 3']))
    expect(run.state).toBe('running')
    const done = await q.wait(run.id, 10_000)
    expect(done?.state).toBe('failed')
    expect(done?.exit).toBe(3)
    expect(q.output(run.id, 0).text).toBe('out\nerr\n')
    expect(q.tail(run.id)).toContain('err')
  })

  test('exit 0 is passed', async () => {
    const q = queue()
    const run = q.enqueue(ask(['sh', '-c', 'exit 0']))
    expect((await q.wait(run.id, 10_000))?.state).toBe('passed')
  })

  test('a command that is not there fails as the shell says: 127', async () => {
    const q = queue()
    const run = q.enqueue(ask(['no-such-command-here-kq']))
    const done = await q.wait(run.id, 10_000)
    expect(done?.exit).toBe(127)
  })

  test('runs in its folder with its environment', async () => {
    const q = queue()
    const cwd = scratch()
    const run = q.enqueue(ask(['sh', '-c', 'pwd; echo "$ONE"'], { cwd, env: { PATH: process.env.PATH!, ONE: 'kept' } }))
    await q.wait(run.id, 10_000)
    expect(q.output(run.id, 0).text).toContain('kept')
    expect(q.output(run.id, 0).text).toContain(cwd.split('/').pop()!)
  })

  test('cancel stops a running run and its whole process group', async () => {
    const q = queue()
    const marker = join(scratch(), 'child-ran')
    const run = q.enqueue(ask(['sh', '-c', `(sleep 2; touch ${marker}) & sleep 5`]))
    await Bun.sleep(300)
    expect(q.cancel(run.id, { person: true })).toBeNull()
    expect(q.get(run.id)?.state).toBe('cancelled')
    await Bun.sleep(2500)
    expect(existsSync(marker)).toBe(false)
  })

  test('a waiting run is cancelled before it starts; only its owner or the person may', async () => {
    const q = queue({ most: 1 })
    const first = q.enqueue(ask(['sh', '-c', 'sleep 1']))
    const second = q.enqueue(ask(['sh', '-c', 'exit 0'], { asker: { via: 'mcp', said: 'x', token: 'tok-a-long-enough-token-1234', conversation: null } }))
    expect(q.get(second.id)?.state).toBe('queued')
    expect(q.cancel(second.id, { key: 'wrong' })).toContain('not yours')
    expect(q.cancel(second.id, { token: 'tok-b-long-enough-token-1234' })).toContain('not yours')
    expect(q.cancel(second.id, { token: 'tok-a-long-enough-token-1234' })).toBeNull()
    expect(q.cancel(first.id, { key: first.key })).toBeNull()
  })
})

describe('capacity, with real runs', () => {
  test('no more than the most at once; the next starts when one ends', async () => {
    const q = queue({ most: 1 })
    const a = q.enqueue(ask(['sh', '-c', 'sleep 1']))
    const b = q.enqueue(ask(['sh', '-c', 'exit 0']))
    expect(q.get(a.id)?.state).toBe('running')
    expect(q.get(b.id)?.state).toBe('queued')
    expect(q.view(q.get(b.id)!).waiting).toContain('Next: waiting for one of the 1 running')
    await q.wait(a.id, 10_000)
    expect((await q.wait(b.id, 10_000))?.state).toBe('passed')
    expect(q.get(b.id)!.startedAt!).toBeGreaterThanOrEqual(q.get(a.id)!.finishedAt!)
  })

  test('a busy machine holds runs until their longest wait, then one starts', async () => {
    let now = 1_000_000
    const q = queue({ load: 50, loadAbove: 9, clock: () => now })
    const run = q.enqueue(ask(['sh', '-c', 'exit 0']))
    expect(q.get(run.id)?.state).toBe('queued')
    now += 10 * 60_000
    q.tick()
    expect(q.get(run.id)?.state).toBe('running')
    expect(q.get(run.id)?.overdue).toBe(true)
    await q.wait(run.id, 10_000)
  })
})

describe('a restart of the queue', () => {
  test('a waiting run is ended as cancelled (its environment was in memory only); a running one is picked up with its exit code', async () => {
    const dir = scratch()
    const first = queue({ dir, most: 1 })
    const running = first.enqueue(ask(['sh', '-c', 'sleep 1; exit 4']))
    const waiting = first.enqueue(ask(['sh', '-c', 'exit 0']))
    first.stop()
    const kept = readFileSync(join(dir, 'runs.json'), 'utf8')
    expect(kept).not.toContain('"env"')
    expect(kept).not.toContain('PATH')
    const second = queue({ dir, most: 1 })
    expect(second.get(waiting.id)?.state).toBe('cancelled')
    expect(second.get(waiting.id)?.why).toContain('restarted')
    expect(second.get(running.id)?.state).toBe('running')
    await Bun.sleep(1500)
    second.tick()
    expect(second.get(running.id)?.state).toBe('failed')
    expect(second.get(running.id)?.exit).toBe(4)
  })
})

describe('publishing run results to the project', () => {
  test('a run for a ref shows in the project\'s runs.json, read as the protocol reads it', async () => {
    const project = scratch()
    mkdirSync(join(project, '.kehikot'))
    const q = queue({ publish: (path, runs) => publish(path, runs) })
    const run = q.enqueue(ask(['sh', '-c', 'exit 0'], { project, refs: ['!3907'], label: 'unit', epic: 'queue' }))
    await q.wait(run.id, 10_000)
    const read = readRuns(project)
    expect(read).toHaveLength(1)
    expect(read[0]).toMatchObject({ id: run.id, from: 'queue', label: 'unit', state: 'passed', exit: 0, refs: ['!3907'], epic: 'queue' })
    expect(latestRuns(read, '!3907').map((one) => one.state)).toEqual(['passed'])
    expect(readFileSync(join(project, '.kehikot', 'queue', '.gitignore'), 'utf8')).toContain('runs.json')
  })
  test('a folder that is not a Kehikot project is never written', () => {
    const folder = scratch()
    expect(publish(folder, [])).toBeNull()
    expect(existsSync(join(folder, '.kehikot'))).toBe(false)
  })
})

describe('the environment a run gets', () => {
  test('secret-looking names are left out unless kept; Kehikot\'s plumbing only for an agent', () => {
    const got = runEnv({ PATH: '/bin', GITHUB_TOKEN: 'x', AWS_SECRET_ACCESS_KEY: 'y', NPM_PASSWORD: 'z', KEHIKOT_QUEUE_DIR: '/q', HOME: '/h' }, ['GITHUB_TOKEN'])
    expect(got).toEqual({ env: { PATH: '/bin', GITHUB_TOKEN: 'x', KEHIKOT_QUEUE_DIR: '/q', HOME: '/h' }, dropped: ['AWS_SECRET_ACCESS_KEY', 'NPM_PASSWORD'] })
    const agent = runEnv({ PATH: '/bin', KEHIKOT_QUEUE_DIR: '/q', PORT: '8110' }, [], true)
    expect(agent).toEqual({ env: { PATH: '/bin' }, dropped: [] })
    expect(runEnv('no')).toEqual({ why: expect.any(String) })
  })
})

