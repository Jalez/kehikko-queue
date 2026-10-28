import { LIMITS, activityItemsSchema, type ActivityItem } from 'kehikot-module-protocol'

import type { Note } from '../store.ts'

/**
 * What Example reports to the host's Inbox (`activity.set`, capability
 * `activity:report`): every open note of the open epic, as `attention` with low
 * priority, at its place. The list is WHOLE each time: a note finished or
 * removed is simply not in the next one, and the host takes it out.
 *
 * The Inbox is the host's one record of what modules need, are doing and have
 * said. Report your things here and keep no list of "notices" of your own.
 */
const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

export function inboxItems(notes: readonly Note[], epic: string | null): ActivityItem[] {
  const items = notes
    .filter((note) => !note.done && note.epic !== null && note.epic === epic)
    .slice(0, LIMITS.ACTIVITY_ITEMS)
    .map((note) => ({
      id: `note:${note.id}`.slice(0, LIMITS.ACTIVITY_ID),
      state: 'attention' as const,
      priority: 'low' as const,
      label: cut(`Open note: ${note.text}`, LIMITS.ACTIVITY_LABEL),
      place: { epic: note.epic!, ...(note.parts.length ? { parts: note.parts.slice(0, LIMITS.PLACE_PARTS) } : {}) },
      ...(Number.isFinite(Date.parse(note.at)) ? { since: Date.parse(note.at) } : {}),
    }))
  return activityItemsSchema.parse(items)
}
