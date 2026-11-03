import { describe, expect, test } from 'bun:test'

import { asExpected, labelBase, needsThePerson, sameWork, superseded, type Comparable } from '../queue/attention.ts'
import type { Origin } from '../queue/origin.ts'

/*
 * When a run asks for the person, and when it stops: pure rules the queue,
 * the Inbox and the page all read (`queue/attention.ts`).
 */

const origin = (branch: string | null): Origin => ({ project: '/p', projectName: null, epic: null, parts: [], kehikko: null, kehikkoName: null, session: null, branch })

const run = (over: Partial<Comparable> = {}): Comparable => ({
  id: 'a',
  label: 'unit',
  cwd: '/p',
  project: null,
  epic: null,
  origin: null,
  queuedAt: 1000,
  state: 'failed',
  seenAt: null,
  ...over,
})

describe('asExpected and needsThePerson', () => {
  test('a failure asks, a pass does not, a seen run does not', () => {
    expect(needsThePerson(run())).toBe(true)
    expect(needsThePerson(run({ state: 'passed' }))).toBe(false)
    expect(needsThePerson(run({ seenAt: 2000 }))).toBe(false)
    expect(needsThePerson(run({ state: 'running', seenAt: null, finishedAt: null } as Partial<Comparable>))).toBe(false)
  })

  test('an expected failure does not ask; a pass that was expected to fail does', () => {
    expect(asExpected(run({ expect: 'fail', state: 'failed' }))).toBe(true)
    expect(needsThePerson(run({ expect: 'fail', state: 'failed' }))).toBe(false)
    expect(asExpected(run({ expect: 'fail', state: 'passed' }))).toBe(false)
    expect(needsThePerson(run({ expect: 'fail', state: 'passed' }))).toBe(true)
    expect(asExpected(run({ state: 'passed' }))).toBe(true)
    expect(needsThePerson(run({ state: 'passed' }))).toBe(false)
  })
})

describe('labelBase', () => {
  test('drops one "(rerun)" ending, with its number, and nothing else', () => {
    expect(labelBase('unit (rerun)')).toBe('unit')
    expect(labelBase('unit (rerun 2)')).toBe('unit')
    expect(labelBase('unit')).toBe('unit')
    expect(labelBase('rerun unit')).toBe('rerun unit')
    expect(labelBase('unit (rerun) again')).toBe('unit (rerun) again')
  })
})

describe('sameWork', () => {
  test('same folder, branch and label base; anything else is other work', () => {
    expect(sameWork(run(), run({ id: 'b' }))).toBe(true)
    expect(sameWork(run(), run({ id: 'b', cwd: '/q' }))).toBe(false)
    expect(sameWork(run(), run({ id: 'b', origin: origin('main') }))).toBe(false)
    expect(sameWork(run({ origin: origin('main') }), run({ id: 'b', origin: origin('main') }))).toBe(true)
    expect(sameWork(run({ origin: origin('main') }), run({ id: 'b', origin: origin('other') }))).toBe(false)
    expect(sameWork(run(), run({ id: 'b', label: 'unit (rerun)' }))).toBe(true)
    expect(sameWork(run(), run({ id: 'b', label: 'other' }))).toBe(false)
  })
})

describe('superseded', () => {
  test('a later pass of the same work answers the earlier failure', () => {
    const bad = run({ id: 'bad', queuedAt: 1000 })
    const good = run({ id: 'good', state: 'passed', queuedAt: 2000 })
    expect(superseded([bad, good])).toEqual([{ id: 'bad', by: 'good' }])
  })

  test('a pass asked before the failure, of other work, or expected to fail does not supersede', () => {
    const bad = run({ id: 'bad', queuedAt: 2000 })
    const early = run({ id: 'early', state: 'passed', queuedAt: 1000 })
    const other = run({ id: 'other', state: 'passed', queuedAt: 3000, label: 'other' })
    const red = run({ id: 'red', state: 'passed', queuedAt: 3000, expect: 'fail' })
    expect(superseded([early, bad])).toEqual([])
    expect(superseded([bad, other])).toEqual([])
    expect(superseded([bad, red])).toEqual([])
  })

  test('a run already seen, or not asking, is not superseded', () => {
    const seen = run({ id: 'seen', seenAt: 1500 })
    const red = run({ id: 'red', expect: 'fail' })
    const good = run({ id: 'good', state: 'passed', queuedAt: 2000 })
    expect(superseded([seen, good])).toEqual([])
    expect(superseded([red, good])).toEqual([])
  })
})
