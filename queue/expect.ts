/**
 * What the asker said a run should come to. Pure: the queue, the doors, the Inbox and the page read it.
 *
 * A run is meant to pass unless the asker said `expect: 'fail'` (a red test written before the fix).
 * Nothing asks for the person either way: the result is said as it came, with "as expected" or
 * "expected to fail" beside it.
 */

export type Expect = 'fail'

export interface Judged {
  state: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled'
  /** 'fail': the asker meant it to fail (a red test first). Absent or null: meant to pass. */
  expect?: Expect | null
}

/** Whether the run came out the way the asker said it would. Only for a run that passed or failed. */
export const asExpected = (run: Judged): boolean => (run.expect === 'fail' ? run.state === 'failed' : run.state === 'passed')
