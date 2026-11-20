import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decide, waitingSaid } from '../queue/schedule.ts'
import { holdDoor, HOLD_PATH } from '../queue/hold-door.ts'
import { Queue, type Ask } from '../queue/queue.ts'
import { workQueueFor } from '../queue/service.ts'

/*
 * An app restart held behind the runs ahead of it (protocol 2.110.0): the host asks for it at `hold`,
 * nothing queued after it starts, and when its turn comes the host is told it may go — or, cancelled
 * here, that it may not. A run an agent asked for keeps its place across this module's own restart.
 */
const made: string[] = []
const queues: Queue[] = []
afterEach(() => {
  for (const q of queues.splice(0)) q.stop()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-hold-'))
  made.push(dir)
  return dir
}
const capacity = { most: 2, loadAbove: 100, waitMs: 10 * 60_000 }

function queue(over: { dir?: string; release?: (token: string, go: boolean) => Promise<string | null>; restoreEnv?: Queue['options']['restoreEnv'] } = {}) {
  const q = new Queue({
    dir: over.dir ?? scratch(),
    capacity: () => capacity,
    load: () => 0,
    ...(over.release ? { release: over.release } : {}),
    ...(over.restoreEnv ? { restoreEnv: over.restoreEnv } : {}),
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
const KEHIKOT = { via: 'mcp' as const, said: 'Kehikot itself', token: null, conversation: null }
const TOKEN = 'abcdefghij0123456789'

describe('the schedule: an app restart is a barrier', () => {
  const at = (id: string, kind: string, rank: number) => ({ id, kind, pri: 1, rank, queuedAt: rank })
  test('runs ahead of it start; nothing behind it does', () => {
    expect(decide([at('a', 'verify', 1), at('r', 'restart', 2), at('b', 'verify', 3)], [], 0, 0, capacity)).toEqual({ start: 'a', overdue: false })
    expect(decide([at('r', 'restart', 2), at('b', 'verify', 3)], [{ kind: 'verify' }], 0, 0, capacity)).toMatchObject({ start: null })
  })
  test('it goes once nothing runs and nothing is ahead, whatever the load', () => {
    expect(decide([at('r', 'restart', 2), at('b', 'verify', 3)], [], 99, 0, capacity)).toEqual({ start: 'r', overdue: false })
  })
  test('what each waiting run is told', () => {
    const waiting = [at('r', 'restart', 2), at('b', 'verify', 3)]
    expect(waitingSaid('r', waiting, [{ kind: 'verify' }], 0, 0, capacity)).toBe('Next: restarts Kehikot when the run ahead of it finishes.')
    expect(waitingSaid('b', waiting, [{ kind: 'verify' }], 0, 0, capacity)).toContain('waits behind the app restart')
  })
})

describe('holding a restart', () => {
  test('nothing running or waiting: not held, so the host restarts now', () => {
    expect(queue().hold(TOKEN, 'Restart Kehikot to update to 0.7.36', KEHIKOT)).toEqual({ held: false, ahead: 0 })
  })

  test('held behind a running run; when that ends the host is told to go, and nothing behind it started first', async () => {
    const told: [string, boolean][] = []
    const q = queue({ release: async (token, go) => (told.push([token, go]), null) })
    const first = q.enqueue(ask(['sh', '-c', 'sleep 0.4']))
    expect(q.hold(TOKEN, 'Restart Kehikot to update to 0.7.36', KEHIKOT)).toEqual({ held: true, ahead: 1 })
    const behind = q.enqueue(ask(['sh', '-c', 'exit 0']))
    expect(q.get(behind.id)?.state).toBe('queued')
    await q.wait(first.id, 10_000)
    q.tick()
    for (let i = 0; i < 40 && !told.length; i++) await new Promise((done) => setTimeout(done, 25))
    expect(told).toEqual([[TOKEN, true]])
    await new Promise((done) => setTimeout(done, 10))
    const restart = q.list().find((run) => run.kind === 'restart')!
    expect(restart).toMatchObject({ state: 'passed', why: 'Kehikot is restarting.', label: 'Restart Kehikot to update to 0.7.36' })
    /* The token is the host's: never shown. */
    expect(JSON.stringify(q.list())).not.toContain(TOKEN)
  })

  test('a second hold takes over the one waiting', () => {
    const q = queue({ release: async () => null })
    q.enqueue(ask(['sh', '-c', 'sleep 2']))
    q.hold(TOKEN, 'Restart Kehikot', KEHIKOT)
    expect(q.hold('zyxwvutsrq9876543210', 'Restart Kehikot to update to 0.7.37', KEHIKOT).held).toBe(true)
    const restarts = q.list().filter((run) => run.kind === 'restart')
    expect(restarts).toHaveLength(1)
    expect(restarts[0]!.label).toBe('Restart Kehikot to update to 0.7.37')
  })

  test('cancelled by the person: the host is told it may not go', async () => {
    const told: [string, boolean][] = []
    const q = queue({ release: async (token, go) => (told.push([token, go]), null) })
    q.enqueue(ask(['sh', '-c', 'sleep 2']))
    q.hold(TOKEN, 'Restart Kehikot', KEHIKOT)
    const restart = q.list().find((run) => run.kind === 'restart')!
    expect(q.cancel(restart.id, { person: true })).toBeNull()
    await new Promise((done) => setTimeout(done, 10))
    expect(told).toEqual([[TOKEN, false]])
  })

  test('the host did not take it: the run says so, and the queue goes on', async () => {
    const q = queue({ release: async () => 'Kehikot holds no such restart any more.' })
    const first = q.enqueue(ask(['sh', '-c', 'sleep 0.2']))
    q.hold(TOKEN, 'Restart Kehikot', KEHIKOT)
    await q.wait(first.id, 10_000)
    q.tick()
    let restart = q.list().find((run) => run.kind === 'restart')!
    for (let i = 0; i < 40 && restart.state !== 'failed'; i++) {
      await new Promise((done) => setTimeout(done, 25))
      restart = q.list().find((run) => run.kind === 'restart')!
    }
    expect(restart).toMatchObject({ state: 'failed', why: 'Kehikot did not restart: Kehikot holds no such restart any more.' })
  })
})

describe('this module restarting', () => {
  test('a waiting agent’s run keeps its place with its environment made again; a shell’s is cancelled for its CLI to ask again; a held restart stays held', async () => {
    const dir = scratch()
    const first = queue({ dir, release: async () => null })
    first.enqueue(ask(['sh', '-c', 'sleep 1'], { label: 'running' }))
    first.enqueue(ask(['sh', '-c', 'sleep 1'], { label: 'also running' }))
    first.enqueue(ask(['sh', '-c', 'exit 0'], { label: 'agent', asker: { via: 'mcp', said: 'an agent', token: null, conversation: null } }))
    first.enqueue(ask(['sh', '-c', 'exit 0'], { label: 'shell' }))
    first.hold(TOKEN, 'Restart Kehikot', KEHIKOT)
    first.stop()
    const second = queue({ dir, release: async () => null, restoreEnv: (run) => (run.asker.via === 'mcp' ? { PATH: process.env.PATH ?? '/usr/bin:/bin' } : null) })
    const by = (label: string) => second.list().find((run) => run.label === label)!
    expect(['queued', 'running', 'passed']).toContain(by('agent').state)
    expect(by('shell')).toMatchObject({ state: 'cancelled', why: 'The queue restarted before this run started. Ask for it again.' })
    expect(['queued', 'running', 'passed']).toContain(by('Restart Kehikot').state)
  })
})

describe('the door', () => {
  test('only the host may hold one, and the descriptor says where', async () => {
    const q = queue({ release: async () => null })
    q.enqueue(ask(['sh', '-c', 'sleep 2']))
    const call = (vouched: boolean, body: unknown) =>
      holdDoor({ queue: () => q, vouch: async () => (vouched ? { ok: true } : { ok: false, why: 'not the host' }) })(
        new Request(`http://127.0.0.1${HOLD_PATH}`, { method: 'POST', body: JSON.stringify(body) }),
        { url: new URL(`http://127.0.0.1${HOLD_PATH}`) } as never,
      )
    expect((await call(false, { token: TOKEN, reason: 'app-update', label: 'Restart' }))!.status).toBe(403)
    expect((await call(true, { token: 'short', reason: 'app-update', label: 'Restart' }))!.status).toBe(400)
    const ok = await call(true, { token: TOKEN, reason: 'app-update', label: 'Restart Kehikot to update to 0.7.36' })
    expect(await ok!.json()).toEqual({ held: true, ahead: 1, why: '' })
    expect(workQueueFor('/x/kehikot-queue').hold).toBe(HOLD_PATH)
  })
})
