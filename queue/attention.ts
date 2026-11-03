import { originOf, type Origin } from './origin.ts'

/**
 * When a run asks for the person, and when it stops. Pure: the queue, the Inbox and the page all
 * read it.
 *
 * A run NEEDS the person when its result is not what was expected and nobody has been shown it yet:
 * a failure (unless the asker said it was meant to fail), or a run meant to fail that passed. It
 * stops when it is seen (`seenAt`): opened from the Inbox, its output opened, marked seen by the
 * person or by the session that asked for it, in view on a visible page for a moment, or superseded
 * by a later passing run of the same work (`supersededBy`).
 */

export type Expect = 'fail'

export interface Judged {
  state: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled'
  seenAt?: number | null
  /** 'fail': the asker meant it to fail (a red test first). Absent or null: meant to pass. */
  expect?: Expect | null
}

/** Whether the run came out the way the asker said it would. Only for a run that passed or failed. */
export const asExpected = (run: Judged): boolean => (run.expect === 'fail' ? run.state === 'failed' : run.state === 'passed')

/** A result nobody expected, not yet shown to anyone: what has the border on the page and the item in the Inbox. */
export const needsThePerson = (run: Judged): boolean => (run.state === 'failed' || run.state === 'passed') && !asExpected(run) && !run.seenAt

/**
 * The work a run is of, without the "(rerun)" an agent adds when it asks again: "unit (rerun)" and
 * "unit (rerun 2)" are "unit". Only that ending, once, so a label that merely mentions a rerun is
 * left as it is.
 */
export const labelBase = (label: string): string => label.replace(/\s*\(rerun(?:\s+\d+)?\)\s*$/i, '').trim()

export interface Comparable extends Judged {
  id: string
  label: string
  cwd: string
  project: string | null
  epic: string | null
  origin?: Origin | null
  queuedAt: number
}

/** Two runs are of the same work: run in the same folder, on the same branch, with the same label (less "(rerun)"). */
export function sameWork(a: Comparable, b: Comparable): boolean {
  if (a.cwd !== b.cwd) return false
  if ((originOf(a)?.branch ?? null) !== (originOf(b)?.branch ?? null)) return false
  return labelBase(a.label) === labelBase(b.label)
}

/**
 * The runs a later pass supersedes: each run still needing the person, with the first run asked
 * after it that passed as expected (not one meant to fail) and is of the same work. One pair per
 * superseded run, in the order given.
 */
export function superseded<R extends Comparable>(runs: readonly R[]): Array<{ id: string; by: string }> {
  const greens = runs.filter((run) => run.state === 'passed' && run.expect !== 'fail').sort((a, b) => a.queuedAt - b.queuedAt)
  const out: Array<{ id: string; by: string }> = []
  for (const run of runs) {
    if (!needsThePerson(run)) continue
    const by = greens.find((green) => green.id !== run.id && green.queuedAt > run.queuedAt && sameWork(run, green))
    if (by) out.push({ id: run.id, by: by.id })
  }
  return out
}
