import { LIMITS, activityItemsSchema, type ActivityItem } from 'kehikot-module-protocol'

import type { RunView } from '../queue/queue.ts'

/**
 * What Test runs reports to the host's Inbox (`activity.set`): each run of the last day that came
 * from a project, filed under that project (`project`, protocol 1.8.0) and its epic. A failed run
 * NEEDS the person (`attention`); a passed or cancelled one is `done`; a waiting or running one is
 * `working`. The list is whole each time.
 */
export const INBOX_HOURS = 24

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export function inboxItems(runs: readonly RunView[], now: number): ActivityItem[] {
  const items: ActivityItem[] = []
  for (const run of runs) {
    if (items.length >= LIMITS.ACTIVITY_ITEMS) break
    if (!run.project) continue
    const when = run.finishedAt ?? run.startedAt ?? run.queuedAt
    if (now - when > INBOX_HOURS * 3_600_000) continue
    const state = run.state === 'failed' ? 'attention' : run.state === 'queued' || run.state === 'running' ? 'working' : 'done'
    const label =
      run.state === 'failed' ? `Tests failed: ${run.label}${run.exit !== null ? ` (exit ${run.exit})` : ''}`
      : run.state === 'passed' ? `Tests passed: ${run.label}`
      : run.state === 'cancelled' ? `Test run cancelled: ${run.label}`
      : run.state === 'running' ? `Tests running: ${run.label}`
      : `Tests waiting: ${run.label}`
    items.push({
      id: `run:${run.id}`.slice(0, LIMITS.ACTIVITY_ID),
      state,
      label: cut(label, LIMITS.ACTIVITY_LABEL),
      detail: cut(`From ${run.asker.said}.${run.why ? ` ${run.why}` : ''}`, LIMITS.ACTIVITY_DETAIL),
      since: when,
      ...(run.state === 'failed' ? { priority: 'normal' as const } : { priority: 'low' as const }),
      ...(run.refs.length ? { refs: run.refs.slice(0, LIMITS.ACTIVITY_REFS) } : {}),
      ...(run.epic ? { place: { epic: run.epic } } : {}),
      project: run.project,
      group: 'test-runs',
    })
  }
  return activityItemsSchema.parse(items)
}
