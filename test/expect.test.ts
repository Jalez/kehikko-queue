import { describe, expect, test } from 'bun:test'

import { asExpected, type Judged } from '../queue/expect.ts'

/* What the asker said a run should come to (`queue/expect.ts`): said beside the result, never asking anyone. */

const run = (over: Partial<Judged> = {}): Judged => ({ state: 'failed', ...over })

describe('asExpected', () => {
  test('a run meant to pass came out as expected only when it passed', () => {
    expect(asExpected(run({ state: 'passed' }))).toBe(true)
    expect(asExpected(run())).toBe(false)
  })

  test('a run meant to fail came out as expected only when it failed', () => {
    expect(asExpected(run({ expect: 'fail', state: 'failed' }))).toBe(true)
    expect(asExpected(run({ expect: 'fail', state: 'passed' }))).toBe(false)
  })
})
