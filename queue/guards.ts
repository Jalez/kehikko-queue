import { GUARD_PATTERN, GUARD_SCRIPT, guardsSchema, type Guard } from 'kehikot-module-protocol'

/**
 * Queue's guards (protocol 2.61.0): the shell commands an agent session on a kehikko Queue is placed
 * on is held to, enforced by the agent modules' hooks — subagents included. Two rewrites:
 *
 *  - `heavy`: a typecheck, a test suite, browser tests, a build, an install, and the package.json
 *    scripts named for them, run through `kehikot-queue run --guard`, which queues what is heavy in
 *    that project and runs the rest (one test file, a script that is light there) at once;
 *  - `dev`: a dev server, run through `kehikot-queue lease dev --guard`, in a leased slot that is
 *    stopped when the command, its time or its session ends.
 *
 * `KEHIKOT_DIRECT=1` in front of a command passes every guard (the protocol's escape). The net here
 * is wide on purpose; the CLI narrows it per project. The person widens or narrows it in Settings ›
 * Modules (`guard_commands`, `guard_scripts`, `guard_direct`), or turns it off (`guards`). Pure.
 */

export const HEAVY_COMMANDS = [
  'tsc', 'vue-tsc', 'tsgo', 'vitest', 'jest', 'bun test', 'playwright test',
  'vite build', 'next build', 'astro build', 'bun build', 'webpack', 'rollup', 'tsup',
  'bun install', 'bun i', 'npm ci', 'npm install', 'npm i', 'pnpm install', 'pnpm i', 'yarn install',
] as const

export const HEAVY_SCRIPTS = [
  'test', 'test:unit', 'test:e2e', 'test:integration', 'test:all', 'test:ci', 'test:coverage', 'test:browser', 'test:run',
  'e2e', 'typecheck', 'type-check', 'check-types', 'types', 'tsc', 'build', 'build:all', 'build:prod',
] as const

/** Asking a tool what it is passes: nothing heavy runs. */
export const ALWAYS_DIRECT = ['tsc --version', 'tsc -v', 'tsc --help', 'vitest --version', 'jest --version', 'playwright --version', 'bun test --help'] as const

export const DEV_COMMANDS = ['vite', 'next dev', 'astro dev', 'nuxt dev', 'webpack serve', 'webpack-dev-server'] as const
export const DEV_SCRIPTS = ['dev', 'start', 'serve', 'preview', 'storybook'] as const

export interface GuardSettings {
  /** False: Queue declares no guards. */
  on: boolean
  /** More command patterns to queue. */
  commands: string[]
  /** More package.json script names to queue. */
  scripts: string[]
  /** Command patterns that run directly. */
  direct: string[]
}

const listOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string').map((one) => one.trim().replace(/\s+/g, ' ')).filter(Boolean) : [])

/** The guard settings from the stored values; defaults for what is not set. */
export function guardSettingsOf(values: Record<string, unknown>): GuardSettings {
  return { on: values.guards !== false, commands: listOf(values.guard_commands), scripts: listOf(values.guard_scripts), direct: listOf(values.guard_direct) }
}

const shellQuoted = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)
const unique = (list: readonly string[], most = 32) => [...new Set(list)].slice(0, most)

/**
 * The guards to declare, for the CLI at `cli` (its absolute path, quoted into the rewrite). Patterns
 * the person wrote that the protocol would not take are left out, never fatal.
 */
export function guardsFor(cli: string, settings: GuardSettings): Guard[] {
  if (!settings.on) return []
  const patterns = (list: readonly string[]) => list.filter((one) => one.length <= 120 && GUARD_PATTERN.test(one))
  const scripts = (list: readonly string[]) => list.filter((one) => GUARD_SCRIPT.test(one))
  const direct = unique([...ALWAYS_DIRECT, ...patterns(settings.direct)])
  const run = shellQuoted(cli)
  return guardsSchema.parse([
    {
      id: 'heavy',
      tool: 'shell',
      match: { commands: unique([...HEAVY_COMMANDS, ...patterns(settings.commands)]), scripts: unique([...HEAVY_SCRIPTS, ...scripts(settings.scripts)]) },
      allow: direct,
      action: 'rewrite',
      rewrite: `${run} run --guard -- sh -c {command}`,
      why: 'Heavy work (a typecheck, tests, a build, an install) waits its turn in the Queue, so sessions do not starve each other. One test file runs at once.',
    },
    {
      id: 'dev',
      tool: 'shell',
      match: { commands: [...DEV_COMMANDS], scripts: [...DEV_SCRIPTS] },
      allow: unique(['vite --version', 'vite --help', ...patterns(settings.direct)]),
      action: 'rewrite',
      rewrite: `${run} lease dev --guard -- sh -c {command}`,
      why: 'A dev server runs in a leased slot, stopped when this command, its time or this session ends.',
    },
  ])
}
