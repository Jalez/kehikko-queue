import { describe, expect, test } from 'bun:test'

import { Feed, KEPT, nothingHeld, take, viewOf, type Delta, type Held } from '../queue/feed.ts'

interface R {
  id: string
  state: string
  note: string
}
type M = { load: number }
const feed = () => new Feed<R, M, string[]>()
const run = (id: string, state = 'queued', note = 'x'.repeat(1000)): R => ({ id, state, note })
const part = (runs: R[], load = 1, leases: string[] = []) => ({ runs, machine: { load }, leases })
const size = (x: unknown) => JSON.stringify(x).length

describe('the queue as a delta', () => {
  test('a page with no token is sent everything, once', () => {
    const f = feed()
    const got = f.read(part([run('a'), run('b')]), null)
    expect(got).toMatchObject({ full: true, order: ['a', 'b'] })
    expect(got.runs).toHaveLength(2)
  })

  test('nothing changed: a few bytes, however long the queue', () => {
    const f = feed()
    const runs = Array.from({ length: 340 }, (_, i) => run(`r${i}`, 'passed'))
    const first = f.read(part(runs), null)
    expect(size(first)).toBeGreaterThan(300_000)
    const again = f.read(part(runs), first.token)
    expect(again).toEqual({ ok: true, token: first.token, unchanged: true })
    expect(size(again)).toBeLessThan(60)
  })

  test('a load that moved sends the machine and no run', () => {
    const f = feed()
    const runs = Array.from({ length: 340 }, (_, i) => run(`r${i}`, 'passed'))
    const first = f.read(part(runs, 1), null)
    const next = f.read(part(runs, 1.1), first.token)
    expect(next.runs).toEqual([])
    expect(next.gone).toEqual([])
    expect(next.machine).toEqual({ load: 1.1 })
    expect(next.order).toBeUndefined()
    expect(next.leases).toBeUndefined()
    expect(size(next)).toBeLessThan(200)
  })

  test('a run that changed is sent whole, one that went is named, and the order comes only when it differs', () => {
    const f = feed()
    const a = f.read(part([run('a', 'running'), run('b'), run('c')]), null)
    const b = f.read(part([run('a', 'passed'), run('b'), run('c')]), a.token)
    expect(b.runs?.map((r) => r.id)).toEqual(['a'])
    expect(b.order).toBeUndefined()
    const c = f.read(part([run('a', 'passed'), run('c'), run('d')]), b.token)
    expect(c.runs?.map((r) => r.id)).toEqual(['d'])
    expect(c.gone).toEqual(['b'])
    expect(c.order).toEqual(['a', 'c', 'd'])
  })

  test('a token the server has forgotten, or never made, gets the whole', () => {
    const f = feed()
    const first = f.read(part([run('a')]), null)
    for (let i = 0; i < KEPT + 2; i++) f.read(part([run('a'), run(`n${i}`)]), null)
    expect(f.read(part([run('a')]), first.token).full).toBe(true)
    expect(f.read(part([run('a')]), 9999).full).toBe(true)
  })

  test('two pages at different tokens each get what is theirs', () => {
    const f = feed()
    const t1 = f.read(part([run('a')]), null).token
    const t2 = f.read(part([run('a'), run('b')]), t1).token
    const t3 = f.read(part([run('a'), run('b'), run('c')]), t2)
    expect(f.read(part([run('a'), run('b'), run('c')]), t1).runs?.map((r) => r.id)).toEqual(['b', 'c'])
    expect(t3.runs?.map((r) => r.id)).toEqual(['c'])
  })
})

describe('the page taking the answers', () => {
  const hold = (f: Feed<R, M, string[]>, held: Held<R, M, string[]>, now: ReturnType<typeof part>) => {
    const got = f.read(now, held.token) as Delta<R, M, string[]>
    return take(held, got)
  }

  test('what the page holds is always the queue, in its order, through any run of answers', () => {
    const f = feed()
    let held: Held<R, M, string[]> = nothingHeld()
    const steps = [
      part([run('a', 'running'), run('b')], 1),
      part([run('a', 'running'), run('b')], 1),
      part([run('a', 'passed'), run('b', 'running')], 2, ['l']),
      part([run('b', 'running'), run('c')], 2, ['l']),
      part([run('c'), run('b', 'passed')], 3),
    ]
    for (const now of steps) {
      held = hold(f, held, now)!
      expect(viewOf(held)).toEqual({ runs: now.runs, machine: now.machine, leases: now.leases })
    }
  })

  test('an answer it cannot apply is refused, so the page asks for the whole', () => {
    expect(take(nothingHeld<R, M, string[]>(), { token: 1, unchanged: true })).toBeNull()
    expect(take(nothingHeld<R, M, string[]>(), { token: 1, runs: [run('a')], order: ['a', 'zz'], machine: { load: 1 }, leases: [] })).toBeNull()
    expect(take(nothingHeld<R, M, string[]>(), {})).toBeNull()
  })
})
