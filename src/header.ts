import { headerItemsSchema, type HeaderItem, type ModuleScope } from 'kehikot-module-protocol'

/**
 * Test runs' header, and which runs it shows.
 *
 * Which runs show is the container's SCOPE (protocol 2.29.0), not a switch of
 * its own: `machine` ("This computer", the default) is every project's runs,
 * `project` the open project's. The person picks it in the module's settings
 * window in the host, and the host tells the page in `context.scope`. The
 * header's old "Show: This project / Every project" was that same choice, and
 * is gone so there is one setting, not two. So the header declares nothing.
 */
export type Showing = 'here' | 'all'

export const SHOWING: readonly Showing[] = ['here', 'all']

export const LABEL_FIT = 24

/** What the page shows at a scope: the open project's runs at `project` (when one is open), else every project's. */
export function showingOf(scope: ModuleScope | undefined, projectPath: string | null): Showing {
  return scope === 'project' && projectPath ? 'here' : 'all'
}

/** The header: nothing. Declared, so a host draws no menus rather than guessing. */
export function headerItems(): HeaderItem[] {
  return headerItemsSchema.parse([])
}

/** What an agent pressing the old switch is told: the scope is the person's, in the settings window. */
export const SCOPE_IS_THE_PERSONS =
  'Which projects’ runs Test runs shows is its scope — This computer or Project — and the person picks it in its settings.'

export function pressed(item: string, _value: unknown): string {
  if (item === 'show') return SCOPE_IS_THE_PERSONS
  return `Test runs has nothing called "${item.slice(0, 40)}" to press.`
}
