import { LIMITS, activityItemSchema, activityItemsSchema, type ActivityItem } from 'kehikot-module-protocol'

import { baseName, originOf } from '../queue/origin.ts'
import type { RunView } from '../queue/queue.ts'

/**
 * What Test runs reports to the host's Inbox (`activity.set`): each run of the last day that came
 * from a project, filed under that project (`project`, protocol 1.8.0) and the place it was asked
 * from (epic and parts). A failed run NEEDS the person (`attention`) until it has been shown
 * to them — opened from the Inbox, or its output opened on the page (`needsThePerson`); then it
 * leaves the list, and the run stays in the page's. A passed or cancelled one is `done`; a waiting
 * or running one is `working`. The list is whole each time.
 */
export const INBOX_HOURS = 24

/** The Inbox item of a run, by run id; and back. */
export const itemIdOf = (runId: string) => `run:${runId}`.slice(0, LIMITS.ACTIVITY_ID)
export const runIdOf = (item: string): string | null => (item.startsWith('run:') && item.length > 4 ? item.slice(4) : null)

/** A failure nobody has been shown yet: what has the outline on the page and the item in the Inbox. */
export const needsThePerson = (run: Pick<RunView, 'state' | 'seenAt'>): boolean => run.state === 'failed' && !run.seenAt

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
    /* Shown to the person already: it has done its asking, and the run stays in the page's list. */
    if (run.state === 'failed' && !needsThePerson(run)) continue
    const state = run.state === 'failed' ? 'attention' : run.state === 'queued' || run.state === 'running' ? 'working' : 'done'
    const where = whereItRan(run)
    const label =
      run.state === 'failed' ? `Tests failed: ${run.label} ${where}${run.exit !== null ? ` (exit ${run.exit})` : ''}`
      : run.state === 'passed' ? `Tests passed: ${run.label} ${where}`
      : run.state === 'cancelled' ? `Test run cancelled: ${run.label} ${where}`
      : run.state === 'running' ? `Tests running: ${run.label} ${where}`
      : `Tests waiting: ${run.label} ${where}`
    const branch = originOf(run)?.branch
    const detail = `Started by ${run.asker.said.replace(/\.$/, '')}. Ran in ${run.cwd}${branch ? ` on branch ${branch}` : ''}.${run.state === 'failed' ? ' Open it to see its output in Test runs.' : ''}${run.why ? ` ${run.why}` : ''}`
    const place = placeOf(run)
    items.push({
      id: itemIdOf(run.id),
      state,
      label: cut(label, LIMITS.ACTIVITY_LABEL),
      detail: cut(detail, LIMITS.ACTIVITY_DETAIL),
      since: when,
      ...(run.state === 'failed' ? { priority: 'normal' as const } : { priority: 'low' as const }),
      ...(run.refs.length ? { refs: run.refs.slice(0, LIMITS.ACTIVITY_REFS) } : {}),
      ...(place ? { place } : {}),
      project: run.project,
      group: 'test-runs',
    })
  }
  return activityItemsSchema.parse(items)
}
