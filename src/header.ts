import { headerItemsSchema, type HeaderItem } from 'kehikot-module-protocol'

/**
 * Test runs' header: one View switch, the runs of the open project or of every project on this
 * computer. The host draws it; this page owns the state. Harmless, so agents may press it.
 */
export type Showing = 'here' | 'all'

export const SHOWING: readonly Showing[] = ['here', 'all']

export const LABEL_FIT = 24

export function headerItems(showing: Showing): HeaderItem[] {
  return headerItemsSchema.parse([
    {
      kind: 'switch',
      id: 'show',
      label: 'Show',
      agents: true,
      options: [
        { id: 'here', label: 'This project' },
        { id: 'all', label: 'Every project' },
      ],
      value: showing,
    },
  ])
}

export function pressed(item: string, value: unknown): Showing | string {
  if (item !== 'show') return `Test runs has nothing called "${item.slice(0, 40)}" to press.`
  return SHOWING.includes(value as Showing) ? (value as Showing) : `"${String(value).slice(0, 40)}" is not a view of Test runs.`
}
