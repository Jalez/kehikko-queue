import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { kindOf } from '../queue/asks.ts'
import { LIMIT_DEFAULTS, limitOf, publishedKind } from '../queue/kinds.ts'
import { Queue } from '../queue/queue.ts'
import { decide, priorityOf, waitingSaid, type Capacity, type Waiting } from '../queue/schedule.ts'
import { capacityOf, leasesOf, perKindOf, readValues, writeValue } from '../queue/settings.ts'
import { SETTINGS } from '../queue/fields.ts'
import { whoAsked } from '../queue/who.ts'
import type { Spawner } from '../queue/runner.ts'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-limits-'))
  made.push(dir)
  return dir
}

const cap: Capacity = { most: 6, loadAbove: 100, waitMs: 600_000, perKind: { ...LIMIT_DEFAULTS } }
const w = (id: string, kind: string, queuedAt: number): Waiting => ({ id, kind, pri: priorityOf(kind), rank: queuedAt, queuedAt })

describe('kinds: typecheck and e2e, and their other words', () => {
  test('unit is tests, playwright is e2e, tsc is typecheck', () => {
    expect(kindOf('unit')).toEqual({ ok: true, value: 'verify' })
    expect(kindOf('playwright')).toEqual({ ok: true, value: 'e2e' })
    expect(kindOf('tsc')).toEqual({ ok: true, value: 'typecheck' })
    expect(kindOf('typecheck')).toEqual({ ok: true, value: 'typecheck' })
  })
  test('each counts against its own limit; other is a task; push and review have none', () => {
    expect(['verify', 'typecheck', 'e2e', 'build', 'task', 'other', 'push', 'review'].map(limitOf)).toEqual(['verify', 'typecheck', 'e2e', 'build', 'task', 'task', null, null])
  })
  test('published as the protocol\'s kinds: a typecheck and e2e are verify', () => {
    expect(publishedKind('typecheck')).toBe('verify')
    expect(publishedKind('e2e')).toBe('verify')
  })
})

describe('per-kind limits, machine-wide', () => {
  test('the defaults: e2e 1, typecheck 1, tests 2, build 1, task 2', () => {
    expect(LIMIT_DEFAULTS).toEqual({ e2e: 1, typecheck: 1, verify: 2, build: 1, task: 2 })
    expect(perKindOf({})).toEqual(LIMIT_DEFAULTS)
    expect(capacityOf({}, 12).perKind).toEqual(LIMIT_DEFAULTS)
  })
  test('a second typecheck waits while one runs; the test suite behind it starts instead', () => {
    const waiting = [w('t2', 'typecheck', 1), w('v1', 'verify', 2)]
    expect(decide(waiting, [{ kind: 'typecheck' }], 0, 10, cap)).toEqual({ start: 'v1', overdue: false })
    expect(decide([w('t2', 'typecheck', 1)], [{ kind: 'typecheck' }], 0, 10, cap)).toEqual({ start: null, why: expect.stringContaining('as many at once') })
  })
  test('two test suites at once, a third waits; other counts as a task', () => {
    expect(decide([w('v3', 'verify', 1)], [{ kind: 'verify' }, { kind: 'verify' }], 0, 10, cap).start).toBeNull()
    expect(decide([w('o', 'other', 1)], [{ kind: 'task' }, { kind: 'other' }], 0, 10, cap).start).toBeNull()
    expect(decide([w('p', 'push', 1)], [{ kind: 'verify' }, { kind: 'verify' }], 0, 10, cap).start).toBe('p')
  })
  test('the overall limit still holds over the kinds', () => {
    expect(decide([w('b', 'build', 1)], [{ kind: 'verify' }], 0, 10, { ...cap, most: 1 }).start).toBeNull()
  })
  test('a kind\'s limit of 0 is no limit of its own', () => {
    expect(decide([w('t2', 'typecheck', 1)], [{ kind: 'typecheck' }], 0, 10, { ...cap, perKind: { ...cap.perKind, typecheck: 0 } }).start).toBe('t2')
  })
  test('the overdue bound does not break a kind\'s limit', () => {
    const waiting = [w('e2', 'e2e', 0), w('v', 'verify', 1)]
    expect(decide(waiting, [{ kind: 'e2e' }], 500, 11 * 60_000, cap)).toEqual({ start: 'v', overdue: true })
  })
  test('a waiting run says its place and what it waits for', () => {
    const waiting = [w('t2', 'typecheck', 1)]
    expect(waitingSaid('t2', waiting, [{ kind: 'typecheck' }], 0, 10, cap)).toBe('Next: waiting for the typecheck run running to finish (1 typecheck at once).')
    const two = [w('a', 'verify', 1), w('b', 'verify', 2)]
    expect(waitingSaid('b', two, [{ kind: 'verify' }, { kind: 'verify' }], 0, 10, cap)).toBe('2nd in the queue: waiting for the 2 tests runs running to finish (2 tests at once).')
  })
  test('the queue holds the limits: two typechecks asked at once run one after the other', async () => {
    const dir = scratch()
    const exits: Array<(code: number) => void> = []
    const started: string[] = []
    const spawner: Spawner = {
      start({ argv }) {
        started.push(argv.join(' '))
        return { pid: process.pid, exited: new Promise<number>((done) => exits.push(done)) }
      },
    }
    const q = new Queue({ dir, capacity: () => cap, load: () => 0, spawner })
    const asker = { via: 'cli' as const, said: 'a shell, in /tmp', token: null, conversation: null, session: 'abc123456789', agent: 'Claude Code' }
    const ask = (label: string) => q.enqueue({ argv: ['echo', label], cwd: tmpdir(), env: {}, kind: 'typecheck', label, refs: [], epic: null, project: null, asker })
    const one = ask('one')
    const two = ask('two')
    expect(q.get(one.id)!.state).toBe('running')
    expect(q.get(two.id)!.state).toBe('queued')
    expect(q.view(q.get(two.id)!).waiting).toContain('1 typecheck at once')
    expect(q.view(q.get(two.id)!).position).toBe(1)
    exits[0]!(0)
    await new Promise((done) => setTimeout(done, 10))
    expect(q.get(two.id)!.state).toBe('running')
    expect(started).toEqual(['echo one', 'echo two'])
    q.stop()
  })
})

describe('the settings', () => {
  test('each kind\'s limit and the dev-server slots are settings the person sets on this machine', () => {
    const keys = SETTINGS.map((one) => one.key)
    expect(keys).toEqual(expect.arrayContaining(['kind_e2e', 'kind_typecheck', 'kind_verify', 'kind_build', 'kind_task', 'leases']))
    for (const one of SETTINGS) expect(one).toMatchObject({ scope: 'machine', personOnly: true })
  })
  test('a limit is a whole number from 0; written and read back', () => {
    const dir = scratch()
    expect(writeValue(dir, 'kind_typecheck', 2)).toBeNull()
    expect(writeValue(dir, 'kind_typecheck', 1.5)).toContain('whole number')
    expect(writeValue(dir, 'leases', -1)).toContain('whole number')
    expect(writeValue(dir, 'leases', 5)).toBeNull()
    expect(perKindOf(readValues(dir)).typecheck).toBe(2)
    expect(leasesOf(readValues(dir))).toBe(5)
    expect(leasesOf({})).toBe(3)
  })
})

describe('who asked', () => {
  test('the agent and its session, short; else what the asker said', () => {
    const base = { via: 'cli' as const, said: 'a shell, in /tmp/x', token: null, conversation: null }
    expect(whoAsked({ ...base, agent: 'Claude Code', session: '9186314e-8c95' })).toBe('Claude Code (session 9186314e)')
    expect(whoAsked({ ...base, session: '9186314e-8c95' })).toBe('session 9186314e')
    expect(whoAsked(base)).toBe('a shell')
  })
})
