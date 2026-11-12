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

export { autoLoad, loadLimitSaid, loadText, LOAD_KEY, MOST_KEY } from './load.ts'
import { autoLoad, loadText, LOAD_KEY, MOST_KEY } from './load.ts'

/**
 * How much may run at once, as the person sets it in Kehikot's Settings › Modules (protocol 2.15.0).
 * Kept on this machine (`scope: 'machine'`): it is about this computer's cores, not a project. Only
 * the person changes it (`personOnly`), because it decides when commands run.
 */
/* Pure, like everything the page can import (manifest.ts is one): the core count is the server's to read (settings.ts) and is handed in. */
export const settingsFor = (cores: number): SettingField[] => settingsDeclarationSchema.parse([
  {
    key: MOST_KEY,
    label: 'Runs at once',
    description: 'How many runs (tests, builds, other heavy commands) may run at the same time. 0 lets Queue decide: one for every six cores.',
    type: 'number',
    default: 0,
    scope: 'machine',
    personOnly: true,
  },
  {
    key: LOAD_KEY,
    label: 'Pause new runs above load',
    description: `New runs wait while this computer's load is above this number: its 1-minute load average, the number and the dashed line on Queue's Load chart. It has ${cores} cores, so a load of ${cores} keeps every core busy. 0 lets Queue decide: ${loadText(autoLoad(cores))} here.`,
    type: 'number',
    default: 0,
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
  {
    key: 'guards',
    label: 'Hold agents to the queue',
    description: 'On a kehikko Queue is on, agent sessions and their subagents run heavy commands through the queue and dev servers in a leased slot, without being asked. KEHIKOT_DIRECT=1 in front of a command runs it directly.',
    type: 'boolean',
    default: true,
    scope: 'machine',
    personOnly: true,
  },
  {
    key: 'guard_commands',
    label: 'Also queue these commands',
    description: 'One command a line, as its first words ("cargo test", "pytest"), queued like a typecheck or a test suite. Taken when Queue next starts.',
    type: 'list',
    default: [],
    scope: 'machine',
    personOnly: true,
  },
  {
    key: 'guard_scripts',
    label: 'Also queue these package.json scripts',
    description: 'One script name a line ("check", "lint:all"). Scripts named test, typecheck, build and the like are queued already, when their own line is heavy work.',
    type: 'list',
    default: [],
    scope: 'machine',
    personOnly: true,
  },
  {
    key: 'guard_direct',
    label: 'Always run these directly',
    description: 'One command a line, as its first words ("tsc --noEmit -p small"): never queued. One test file always runs directly.',
    type: 'list',
    default: [],
    scope: 'machine',
    personOnly: true,
  },
])

