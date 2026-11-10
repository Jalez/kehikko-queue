/*
 * The kinds of run, and how each is said. Pure: the queue, the doors, the Inbox and the page read it.
 */

/**
 * What a run is for, by its asker's word. `verify`: tests, the default. `build`: a build. `task`: any
 * other heavy command (a big install, a migration, a long script). `push`: a pre-push hook somebody
 * waits on. `review`: a review round. `other`: what `task` was called before; still taken, said as a task.
 * `typecheck`: a typecheck (tsc). `e2e`: end-to-end tests in a browser (Playwright), the heaviest.
 * The protocol's run results know push, verify, review and other: a build or a task is published as other.
 */
export const RUN_KINDS = ['verify', 'build', 'task', 'push', 'review', 'other', 'typecheck', 'e2e'] as const
export type Kind = (typeof RUN_KINDS)[number]
/** A run asked for without a kind is tests, as every run was before the queue took other work. */
export const DEFAULT_KIND: Kind = 'verify'

/** A kind in a person's words, for a badge, a tooltip and a sentence. */
export const KIND_WORDS: Record<Kind, string> = { verify: 'tests', build: 'build', task: 'task', push: 'push', review: 'review', other: 'task', typecheck: 'typecheck', e2e: 'e2e tests' }

/** Other words a caller may use for a kind: unit tests are tests, Playwright is e2e. */
export const KIND_ALIASES: Record<string, Kind> = { unit: 'verify', test: 'verify', tests: 'verify', playwright: 'e2e', tsc: 'typecheck' }

/** A kind, or one of its other words, as the kind; null when it is neither. */
export const kindNamed = (said: unknown): Kind | null =>
  typeof said !== 'string' ? null : (RUN_KINDS as readonly string[]).includes(said) ? (said as Kind) : (KIND_ALIASES[said] ?? null)

/**
 * The kinds that have a limit of their own on how many run at once, machine-wide (Settings ›
 * Modules), and the default of each. A kind not here (push, review) is held by "Runs at once" only.
 */
export const LIMITED = ['e2e', 'typecheck', 'verify', 'build', 'task'] as const
export type Limited = (typeof LIMITED)[number]
export const LIMIT_DEFAULTS: Record<Limited, number> = { e2e: 1, typecheck: 1, verify: 2, build: 1, task: 2 }
/** Which limit a kind counts against: `other` is a task. Null: none of its own. */
export const limitOf = (kind: string): Limited | null => (kind === 'other' ? 'task' : (LIMITED as readonly string[]).includes(kind) ? (kind as Limited) : null)
/** The kind in a person's words, for a kind this version may not know (a run kept by a later one). */
export const kindSaid = (kind: string): string => KIND_WORDS[kind as Kind] ?? 'task'
/** Whether a run is said as tests ("Tests failed"): a verify run, and a push, whose hook runs the checks. */
export const isTests = (kind: string): boolean => kind === 'verify' || kind === 'push' || kind === 'e2e'

/** The kind as the protocol's run results spell it (push, verify, review, other): a typecheck or e2e is verify, a build or a task is other. */
export const publishedKind = (kind: Kind): 'push' | 'verify' | 'review' | 'other' => (kind === 'push' || kind === 'verify' || kind === 'review' ? kind : kind === 'typecheck' || kind === 'e2e' ? 'verify' : 'other')
