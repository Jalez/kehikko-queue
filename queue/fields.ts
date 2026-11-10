import { settingsDeclarationSchema, type SettingField } from 'kehikot-module-protocol'

import { LIMIT_DEFAULTS } from './kinds.ts'

/** A per-kind limit's setting key: `kind_typecheck`. */
export const kindKey = (kind: string) => `kind_${kind}`

/** The per-kind limits, as the person reads them in Settings › Modules. */
const KIND_FIELDS: Array<{ kind: keyof typeof LIMIT_DEFAULTS; label: string; what: string }> = [
  { kind: 'e2e', label: 'E2E runs at once', what: 'end-to-end runs (Playwright)' },
  { kind: 'typecheck', label: 'Typechecks at once', what: 'typechecks (tsc)' },
  { kind: 'verify', label: 'Test suites at once', what: 'test suites (unit tests: bun test, vitest, jest)' },
  { kind: 'build', label: 'Builds at once', what: 'builds' },
  { kind: 'task', label: 'Other tasks at once', what: 'other heavy commands (installs, scripts)' },
]

/** How many dev servers may be leased at once, before the person says otherwise. */
export const LEASES_DEFAULT = 3

/**
 * How much may run at once, as the person sets it in Kehikot's Settings › Modules (protocol 2.15.0).
 * Kept on this machine (`scope: 'machine'`): it is about this computer's cores, not a project. Only
 * the person changes it (`personOnly`), because it decides when commands run.
 */
export const SETTINGS: SettingField[] = settingsDeclarationSchema.parse([
  {
    key: 'most',
    label: 'Runs at once',
    description: 'How many runs (tests, builds, other heavy commands) may run at the same time. 0 lets Queue decide: one for every six cores.',
    type: 'number',
    default: 0,
    scope: 'machine',
    personOnly: true,
  },
  {
    key: 'load',
    label: 'Busy above (load per core)',
    description: 'No new run starts while the machine\'s 1-minute load is above this many per core. 0.75 on 12 cores is 9.',
    type: 'number',
    default: 0.75,
    scope: 'machine',
    personOnly: true,
  },
  {
    key: 'wait',
    label: 'Start anyway after (minutes)',
    description: 'A run that has waited this long for the load to fall starts when a slot is free, so nothing waits forever.',
    type: 'number',
    default: 10,
    scope: 'machine',
    personOnly: true,
  },
  ...KIND_FIELDS.map(({ kind, label, what }) => ({
    key: kindKey(kind),
    label,
    description: `How many ${what} may run at the same time on this computer, from every session. 0: no limit of their own (Runs at once still holds).`,
    type: 'number' as const,
    default: LIMIT_DEFAULTS[kind],
    scope: 'machine' as const,
    personOnly: true,
  })),
  {
    key: 'leases',
    label: 'Dev servers at once',
    description: 'How many dev servers agents may lease at the same time (kehikot-queue lease dev, queue_lease). Each is stopped when its lease is released, runs out, or its session ends.',
    type: 'number',
    default: LEASES_DEFAULT,
    scope: 'machine',
    personOnly: true,
  },
])

