import { describe, expect, test } from 'bun:test'

import { decide, defaultCapacity, moved, ordered, priorityOf, waitingSaid, type Capacity, type Waiting } from '../queue/schedule.ts'
import { capacityOf } from '../queue/settings.ts'

const MIN = 60_000
const cap: Capacity = { most: 2, loadAbove: 9, waitMs: 10 * MIN }
const w = (id: string, kind: string, queuedAt: number): Waiting => ({ id, pri: priorityOf(kind), rank: queuedAt, queuedAt })

describe('capacity', () => {
  test('nothing starts while the most at once are running', () => {
    expect(decide([w('a', 'push', 0)], 2, 0, 0, cap)).toEqual({ start: null, why: expect.stringContaining('2 running') })
    expect(decide([w('a', 'push', 0)], 1, 0, 0, cap)).toEqual({ start: 'a', overdue: false })
  })
  test('the defaults follow the cores: one per six, the load guard at three quarters a core', () => {
    expect(defaultCapacity(12)).toEqual({ most: 2, loadAbove: 9, waitMs: 10 * MIN })
    expect(defaultCapacity(4)).toEqual({ most: 1, loadAbove: 3, waitMs: 10 * MIN })
    expect(defaultCapacity(24).most).toBe(4)
  })
  test('the settings override, 0 is automatic', () => {
    expect(capacityOf({}, 12)).toEqual(defaultCapacity(12))
    expect(capacityOf({ most: 3, load: 0.5, wait: 2 }, 12)).toEqual({ most: 3, loadAbove: 6, waitMs: 2 * MIN })
    expect(capacityOf({ most: 0 }, 12).most).toBe(2)
  })
})

describe('the load guard and its bound', () => {
  test('a busy machine holds a new run', () => {
    expect(decide([w('a', 'push', 0)], 0, 12, 5 * MIN, cap)).toEqual({ start: null, why: expect.stringContaining('12.0, above 9.0') })
  })
  test('but never forever: after waitMs the oldest starts if a slot is free', () => {
    const queue = [w('young', 'push', 9 * MIN), w('old', 'verify', 0)]
    expect(decide(queue, 0, 30, 10 * MIN, cap)).toEqual({ start: 'old', overdue: true })
    expect(decide(queue, 2, 30, 10 * MIN, cap).start).toBeNull()
  })
  test('the load at the guard exactly is not above it', () => {
    expect(decide([w('a', 'push', 0)], 0, 9, 0, cap).start).toBe('a')
  })
  test('a waiting run says what it waits for', () => {
    const queue = [w('a', 'push', 0), w('b', 'verify', 1)]
    expect(waitingSaid('a', queue, 2, 0, 0, cap)).toContain('Next: waiting for one of the 2 running')
    expect(waitingSaid('b', queue, 0, 12, 4 * MIN, cap)).toContain('2nd in the queue: the machine\'s load is 12.0')
    expect(waitingSaid('b', queue, 0, 12, 4 * MIN, cap)).toContain('in 7 minutes anyway')
  })
})

describe('priority and order', () => {
  test('a push goes before a background run asked earlier; first come first served within a priority', () => {
    const queue = [w('v1', 'verify', 1), w('r1', 'review', 2), w('p1', 'push', 3), w('p2', 'push', 4), w('v2', 'other', 5)]
    expect(ordered(queue).map((one) => one.id)).toEqual(['p1', 'p2', 'v1', 'r1', 'v2'])
    expect(decide(queue, 0, 0, 10, cap).start).toBe('p1')
  })
  test('the person moves a run up, down and to the top, across priorities too', () => {
    const queue = [w('p1', 'push', 1), w('v1', 'verify', 2), w('v2', 'verify', 3), w('v3', 'verify', 4)]
    const apply = (id: string, to: 'up' | 'down' | 'top') => {
      const next = moved(queue, id, to)!
      const one = queue.find((x) => x.id === id)!
      one.pri = next.pri
      one.rank = next.rank
      return ordered(queue).map((x) => x.id)
    }
    expect(apply('v3', 'up')).toEqual(['p1', 'v1', 'v3', 'v2'])
    expect(apply('v3', 'top')).toEqual(['v3', 'p1', 'v1', 'v2'])
    expect(apply('p1', 'down')).toEqual(['v3', 'v1', 'p1', 'v2'])
    expect(moved(queue, 'v3', 'top')).toBeNull()
    expect(moved(queue, 'v2', 'down')).toBeNull()
  })
})
