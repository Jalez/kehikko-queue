import { LIMITS, activityItemSchema, activityItemsSchema, type ActivityItem } from 'kehikot-module-protocol'

import { needsThePerson } from '../queue/attention.ts'
import { baseName, originOf } from '../queue/origin.ts'
import type { RunView } from '../queue/queue.ts'

export { needsThePerson }

/**
 * What Test runs reports to the host's Inbox (`activity.set`): each run of the last day that came
 * from a project, filed under that project (`project`, protocol 1.8.0) and the place it was asked
 * from (epic and parts). A run whose result nobody expected — a failure, or a pass of a run meant
 * to fail — NEEDS the person (`attention`) until it is seen (`needsThePerson`): opened from the
 * Inbox, its output opened, marked seen, in view on a visible page, or superseded by a later pass of
 * the same work. Then it leaves the list, and the run stays in the page's. Its priority is `low`
 * once the session that asked has read it (queue_wait), else `normal`. A run that came out as
 * expected, or was cancelled, is `done`; a waiting or running one is `working`. The list is whole
 * each time.
 */
export const INBOX_HOURS = 24

/** The Inbox item of a run, by run id; and back. */
export const itemIdOf = (runId: string) => `run:${runId}`.slice(0, LIMITS.ACTIVITY_ID)
export const runIdOf = (item: string): string | null => (item.startsWith('run:') && item.length > 4 ? item.slice(4) : null)

/** Whether the protocol takes this place on an activity item: checked alone, so one bad place never fails the list. */
const takes = (place: NonNullable<ActivityItem['place']>): boolean => activityItemSchema.safeParse({ id: 'x', state: 'done', label: '', place }).success

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** Where a run ran, in a person's words: its branch, else the folder. */
export function whereItRan(run: Pick<RunView, 'cwd' | 'origin' | 'project' | 'epic'>): string {
  const branch = originOf(run)?.branch
  return branch ? `on ${branch}` : `in ${baseName(run.cwd)}`
}

/**
 * Where the run's work belongs: its epic and the parts picked when it was asked for. Never the
 * kehikko it was asked from: Kehikot goes to an item's kehikko and lights the module only if it is on
 * it, and an agent's kehikko often has no Test runs. Without one, Kehikot goes to a kehikko that has
 * Test runs (the open one first), so opening the item can show the run.
 */
function placeOf(run: RunView): ActivityItem['place'] | undefined {
  const origin = originOf(run)
  const epic = origin?.epic ?? run.epic
  if (!epic) return undefined
  const full = {
    epic,
    ...(origin?.parts.length ? { parts: origin.parts.slice(0, LIMITS.PLACE_PARTS) } : {}),
  }
  if (takes(full)) return full
  return takes({ epic }) ? { epic } : undefined
}

export function inboxItems(runs: readonly RunView[], now: number): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const run of runs) {
    if (items.length >= LIMITS.ACTIVITY_ITEMS) break
    if (!run.project) continue
    const when = run.finishedAt ?? run.startedAt ?? run.queuedAt
    if (now - when > INBOX_HOURS * 3_600_000) continue
    const asks = needsThePerson(run)
    const meantToFail = run.expect === 'fail'
    /* A surprise already seen has done its asking, and the run stays in the page's list. */
    if ((run.state === 'failed' || run.state === 'passed') && !asks && (meantToFail ? run.state === 'passed' : run.state === 'failed')) continue
    const state = asks ? 'attention' : run.state === 'queued' || run.state === 'running' ? 'working' : 'done'
    const where = whereItRan(run)
    const exit = run.exit !== null ? ` (exit ${run.exit})` : ''
    const label =
      run.state === 'failed' && meantToFail ? `Tests failed as expected: ${run.label} ${where}${exit}`
      : run.state === 'failed' ? `Tests failed: ${run.label} ${where}${exit}`
      : run.state === 'passed' && meantToFail ? `Tests passed but were expected to fail: ${run.label} ${where}`
      : run.state === 'passed' ? `Tests passed: ${run.label} ${where}`
      : run.state === 'cancelled' ? `Test run cancelled: ${run.label} ${where}`
      : run.state === 'running' ? `Tests running: ${run.label} ${where}`
      : `Tests waiting: ${run.label} ${where}`
    const branch = originOf(run)?.branch
    const detail = `Started by ${run.asker.said.replace(/\.$/, '')}. Ran in ${run.cwd}${branch ? ` on branch ${branch}` : ''}.${asks ? ' Open it to see its output in Test runs.' : ''}${asks && run.askerToldAt ? ' The session that asked for it has read the result.' : ''}${run.why ? ` ${run.why}` : ''}`
    const place = placeOf(run)
    items.push({
      id: itemIdOf(run.id),
      state,
      label: cut(label, LIMITS.ACTIVITY_LABEL),
      detail: cut(detail, LIMITS.ACTIVITY_DETAIL),
      since: when,
      /* The asker already read it: still the person's to look at, but not loudly. */
      priority: asks && !run.askerToldAt ? ('normal' as const) : ('low' as const),
      ...(run.refs.length ? { refs: run.refs.slice(0, LIMITS.ACTIVITY_REFS) } : {}),
      ...(place ? { place } : {}),
      project: run.project,
      group: 'test-runs',
    })
  }
  return activityItemsSchema.parse(items)
}
