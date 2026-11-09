/*
 * The kinds of run, and how each is said. Pure: the queue, the doors, the Inbox and the page read it.
 */

/**
 * What a run is for, by its asker's word. `verify`: tests, the default. `build`: a build. `task`: any
 * other heavy command (a big install, a migration, a long script). `push`: a pre-push hook somebody
 * waits on. `review`: a review round. `other`: what `task` was called before; still taken, said as a task.
 * The protocol's run results know push, verify, review and other: a build or a task is published as other.
 */
export const RUN_KINDS = ['verify', 'build', 'task', 'push', 'review', 'other'] as const
export type Kind = (typeof RUN_KINDS)[number]
/** A run asked for without a kind is tests, as every run was before the queue took other work. */
export const DEFAULT_KIND: Kind = 'verify'

/** A kind in a person's words, for a badge, a tooltip and a sentence. */
export const KIND_WORDS: Record<Kind, string> = { verify: 'tests', build: 'build', task: 'task', push: 'push', review: 'review', other: 'task' }
/** The kind in a person's words, for a kind this version may not know (a run kept by a later one). */
export const kindSaid = (kind: string): string => KIND_WORDS[kind as Kind] ?? 'task'
/** Whether a run is said as tests ("Tests failed"): a verify run, and a push, whose hook runs the checks. */
export const isTests = (kind: string): boolean => kind === 'verify' || kind === 'push'

/** The kind as the protocol's run results spell it (push, verify, review, other): a build or a task is other. */
export const publishedKind = (kind: Kind): 'push' | 'verify' | 'review' | 'other' => (kind === 'push' || kind === 'verify' || kind === 'review' ? kind : 'other')
