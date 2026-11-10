import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { Leases, leaseSaid, portFree, rangeOf, withPort, type LeaseAsk } from '../queue/leases.ts'
import { alive } from '../queue/runner.ts'

/*
 * Dev-server leases with real processes (a shell that sleeps), a scratch folder, and a port check
 * the test answers: what is held is that a leased server is stopped — its whole group, by its pid —
 * for every reason a lease ends.
 */
const made: string[] = []
const held: Leases[] = []
afterEach(() => {
  for (const one of held.splice(0)) one.stopAll('test done')
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-leases-'))
  made.push(dir)
  return dir
}
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms))
async function until(check: () => boolean, ms = 3000) {
  for (let waited = 0; waited < ms && !check(); waited += 25) await settle(25)
  return check()
}

function leases(over: { most?: number; busy?: number[]; clock?: () => number; dir?: string } = {}) {
  const one = new Leases({ dir: over.dir ?? scratch(), most: () => over.most ?? 3, free: async (port) => !(over.busy ?? []).includes(port), ...(over.clock ? { clock: over.clock } : {}) })
  held.push(one)
  return one
}

const asker = { via: 'cli' as const, said: 'a shell, in /tmp', token: 'tok', conversation: null, session: 'sess-1', agent: 'Claude Code' }
const ask = (over: Partial<LeaseAsk> = {}): LeaseAsk => ({
  argv: ['sh', '-c', 'echo "on $PORT"; sleep 30 & wait'],
  cwd: tmpdir(),
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  label: 'dev',
  project: null,
  range: [5280, 5299],
  ttlMs: 60 * 60_000,
  asker,
  sessionPid: null,
  ...over,
})

describe('taking a lease', () => {
  test('the first free port of the range, as $PORT and in place of {port}; its output is kept', async () => {
    const l = leases({ busy: [5280] })
    const lease = await l.take(ask({ argv: ['sh', '-c', 'echo "on $PORT and {port}"; sleep 30 & wait'] }))
    if (typeof lease === 'string') throw new Error(lease)
    expect(lease.port).toBe(5281)
    expect(await until(() => l.output(lease.id, 0).text.includes('on 5281 and 5281'))).toBe(true)
    expect(l.view(lease)).not.toHaveProperty('key')
  })
  test('two leases get two ports; no slot or no port is said in a sentence', async () => {
    const l = leases({ most: 2 })
    const a = await l.take(ask())
    const b = await l.take(ask())
    if (typeof a === 'string' || typeof b === 'string') throw new Error('not leased')
    expect(a.port).not.toBe(b.port)
    expect(await l.take(ask())).toContain('All 2 dev-server slots are taken')
    expect(await leases({ busy: [5280, 5281] }).take(ask({ range: [5280, 5281] }))).toContain('No port from 5280 to 5281')
    expect(await leases({ most: 0 }).take(ask())).toContain('not leased on this computer')
  })
  test('ranges and {port}', () => {
    expect(rangeOf(undefined)).toEqual([5280, 5299])
    expect(rangeOf('6000-6010')).toEqual([6000, 6010])
    expect(rangeOf('80-90')).toBeNull()
    expect(rangeOf('6010-6000')).toBeNull()
    expect(withPort(['vite', '--port', '{port}'], 5285)).toEqual(['vite', '--port', '5285'])
  })
  test('a port something listens on is not free', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') })
    try {
      expect(await portFree(server.port!)).toBe(false)
    } finally {
      server.stop(true)
    }
  })
})

describe('a lease ends, and its server\'s whole group is stopped', () => {
  test('released by its key, or by the person; never by someone else', async () => {
    const l = leases()
    const lease = await l.take(ask())
    if (typeof lease === 'string') throw new Error(lease)
    expect(l.release(lease.id, { key: 'wrong' })).toContain('not yours')
    expect(l.release(lease.id, { key: lease.key })).toBeNull()
    expect(l.get(lease.id)!.state).toBe('ended')
    expect(await until(() => !alive(lease.pid!))).toBe(true)
    const other = await l.take(ask())
    if (typeof other === 'string') throw new Error(other)
    expect(l.release(other.id, { person: true })).toBeNull()
    expect(l.get(other.id)!.why).toBe('Stopped by the person.')
  })
  test('its time runs out', async () => {
    let now = 1_000_000
    const l = leases({ clock: () => now })
    const lease = await l.take(ask({ ttlMs: 5 * 60_000 }))
    if (typeof lease === 'string') throw new Error(lease)
    l.tick()
    expect(l.get(lease.id)!.state).toBe('running')
    now += 5 * 60_000
    l.tick()
    expect(l.get(lease.id)!).toMatchObject({ state: 'ended', why: 'Its time ran out.' })
    expect(await until(() => !alive(lease.pid!))).toBe(true)
  })
  test('the agent session that asked has ended', async () => {
    const session = spawn('sleep', ['30'])
    const l = leases()
    const lease = await l.take(ask({ sessionPid: session.pid! }))
    if (typeof lease === 'string') throw new Error(lease)
    l.tick()
    expect(l.get(lease.id)!.state).toBe('running')
    session.kill('SIGKILL')
    await until(() => !alive(session.pid!))
    l.tick()
    expect(l.get(lease.id)!).toMatchObject({ state: 'ended', why: 'The agent session that leased it ended.' })
    expect(await until(() => !alive(lease.pid!))).toBe(true)
  })
  test('the server exits on its own: the slot is free again', async () => {
    const l = leases({ most: 1 })
    const lease = await l.take(ask({ argv: ['sh', '-c', 'exit 3'] }))
    if (typeof lease === 'string') throw new Error(lease)
    expect(await until(() => l.get(lease.id)!.state === 'ended')).toBe(true)
    expect(l.get(lease.id)!.exit).toBe(3)
    expect(typeof (await l.take(ask()))).not.toBe('string')
  })
  test('a restart of the module still knows which group is its own to stop', async () => {
    const dir = scratch()
    const first = leases({ dir })
    const lease = await first.take(ask())
    if (typeof lease === 'string') throw new Error(lease)
    const again = leases({ dir })
    expect(again.get(lease.id)!.state).toBe('running')
    expect(again.release(lease.id, { token: 'tok' })).toBeNull()
    expect(await until(() => !alive(lease.pid!))).toBe(true)
  })
  test('said in a few lines for queue_status', async () => {
    const l = leases()
    const lease = await l.take(ask())
    if (typeof lease === 'string') throw new Error(lease)
    expect(leaseSaid(l.view(lease), lease.startedAt)).toContain(`on port ${lease.port} (http://localhost:${lease.port}) — running, 60 min left`)
  })
})
