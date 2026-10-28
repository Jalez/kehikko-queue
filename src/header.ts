import { headerItemsSchema, type HeaderItem } from 'kehikot-module-protocol'

/**
 * What Example puts in its container's header: one View switch, open notes or
 * all of them. The host draws it (View menu) and relays a press; this page owns
 * the state and declares the whole list again whenever it changes.
 *
 * `agents: true` lets an agent press it with the host's `press_item`: switching
 * a view loses nothing. Never mark a run that writes, sends or deletes for
 * agents, and never one with `confirm`.
 *
 * Labels are text the host draws as text: short words, no markup, no links.
 * Under 300 pixels the menus become icons and under 220 one "⋯", so a label is
 * read in a narrow menu: keep it to a few words (`LABEL_FIT`).
 */
export type Showing = 'open' | 'all'

export const SHOWING: readonly Showing[] = ['open', 'all']

/** How long a label may be and still read in a menu 200 pixels wide. The protocol's bound is 48. */
export const LABEL_FIT = 24

export function headerItems(showing: Showing): HeaderItem[] {
  return headerItemsSchema.parse([
    {
      kind: 'switch',
      id: 'show',
      label: 'Show',
      agents: true,
      options: [
        { id: 'open', label: 'Open notes' },
        { id: 'all', label: 'All notes' },
      ],
      value: showing,
    },
  ])
}

/** What a press asks for: the view, or a sentence saying why it was not taken. */
export function pressed(item: string, value: unknown): Showing | string {
  if (item !== 'show') return `Example has nothing called "${item.slice(0, 40)}" to press.`
  return SHOWING.includes(value as Showing) ? (value as Showing) : `"${String(value).slice(0, 40)}" is not a view of Example.`
}
