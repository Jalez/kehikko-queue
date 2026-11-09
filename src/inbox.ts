import { LIMITS, activityItemSchema, activityItemsSchema, type ActivityItem } from 'kehikot-module-protocol'

import { baseName, originOf } from '../queue/origin.ts'
import { isTests } from '../queue/kinds.ts'
import type { RunView } from '../queue/queue.ts'

/**
 * What Queue reports to the host's Inbox (`activity.set`): each run of the last day that came
 * from a project, filed under that project (`project`, protocol 1.8.0) and the place it was asked
 * from (epic and parts). Nothing here ever needs the person: a run that ended — passed, failed or
 * cancelled — is a quiet `done`, a waiting or running one is `working`, and every item is `low`
 * priority. Whether it passed is in its label and on the page. The list is whole each time.
 *
 * A verify run, and a push (its hook runs the checks), is said as tests ("Tests failed: …"); a build,
 * a task or a review by its label alone ("Failed: …"), because it is not a test.
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
 * it, and an agent's kehikko often has no Queue. Without one, Kehikot goes to a kehikko that has
 * Queue (the open one first), so opening the item can show the run.
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
    const meantToFail = run.expect === 'fail'
    const state = run.state === 'queued' || run.state === 'running' ? ('working' as const) : ('done' as const)
    const where = whereItRan(run)
    const exit = run.exit !== null ? ` (exit ${run.exit})` : ''
    const label = isTests(run.kind)
      ? run.state === 'failed' && meantToFail ? `Tests failed as expected: ${run.label} ${where}${exit}`
        : run.state === 'failed' ? `Tests failed: ${run.label} ${where}${exit}`
        : run.state === 'passed' && meantToFail ? `Tests passed but were expected to fail: ${run.label} ${where}`
        : run.state === 'passed' ? `Tests passed: ${run.label} ${where}`
        : run.state === 'cancelled' ? `Test run cancelled: ${run.label} ${where}`
        : run.state === 'running' ? `Tests running: ${run.label} ${where}`
        : `Tests waiting: ${run.label} ${where}`
      : run.state === 'failed' && meantToFail ? `Failed as expected: ${run.label} ${where}${exit}`
        : run.state === 'failed' ? `Failed: ${run.label} ${where}${exit}`
        : run.state === 'passed' && meantToFail ? `Passed but was expected to fail: ${run.label} ${where}`
        : run.state === 'passed' ? `Passed: ${run.label} ${where}`
        : run.state === 'cancelled' ? `Cancelled: ${run.label} ${where}`
        : run.state === 'running' ? `Running: ${run.label} ${where}`
        : `Waiting: ${run.label} ${where}`
    const branch = originOf(run)?.branch
    const detail = `Started by ${run.asker.said.replace(/\.$/, '')}. Ran in ${run.cwd}${branch ? ` on branch ${branch}` : ''}.${run.why ? ` ${run.why}` : ''}`
    const place = placeOf(run)
    items.push({
      id: itemIdOf(run.id),
      state,
      label: cut(label, LIMITS.ACTIVITY_LABEL),
      detail: cut(detail, LIMITS.ACTIVITY_DETAIL),
      since: when,
      priority: 'low' as const,
      ...(run.refs.length ? { refs: run.refs.slice(0, LIMITS.ACTIVITY_REFS) } : {}),
      ...(place ? { place } : {}),
      project: run.project,
      group: 'test-runs',
    })
  }
  return activityItemsSchema.parse(items)
}
