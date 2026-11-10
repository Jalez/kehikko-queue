import { KIND_WORDS, limitOf, type Kind, type Limited } from './kinds.ts'

/**
 * When a queued run starts. Pure: the queue hands in what is waiting, what is running, the load and
 * the clock, and this says which run starts now, or none and why.
 *
 *  - At most `most` heavy runs at once, and of each limited kind at most its own limit
 *    (`perKind`: one typecheck, one e2e, two test suites…), machine-wide. A run whose kind is full
 *    waits; the next one in line whose kind has room starts instead.
 *  - No new run while the 1-minute load average is above `loadAbove`, because the machine is busy
 *    with something (often runs that are not in this queue).
 *  - But never forever: a run that has waited `waitMs` starts when a slot is free, whatever the load.
 *    The oldest such run goes first.
 *  - Otherwise in order: a push (somebody waiting at a terminal) before anything else, first come first
 *    served within a priority, as the person reordered it.
 */

export interface Capacity {
  /** How many runs at once. */
  most: number
  /** The 1-minute load average above which nothing new starts (until a run has waited `waitMs`). */
  loadAbove: number
  /** How long a run waits for the load to fall before it starts anyway, in ms. */
  waitMs: number
  /** How many of each limited kind (`limitOf`) may run at once; a kind absent, or 0, has no limit of its own. */
  perKind?: Partial<Record<Limited, number>>
}

export interface Waiting {
  id: string
  /** Lower goes first: 0 is a push. */
  pri: number
  /** Within a priority, lower goes first: when it was asked for, unless the person moved it. */
  rank: number
  queuedAt: number
  /** Its kind, for the limit of its own; absent is a kind with none. */
  kind?: string
}

/** What is running, as far as the schedule needs: its kind. */
export interface Running {
  kind: string
}

export const KIND_PRIORITY: Record<string, number> = { push: 0, verify: 1, build: 1, task: 1, review: 1, other: 1, typecheck: 1, e2e: 1 }

export const priorityOf = (kind: string): number => KIND_PRIORITY[kind] ?? 1

/** The capacity of a machine with `cores` cores, before the person says otherwise. */
export function defaultCapacity(cores: number): Capacity {
  const n = Math.max(1, Math.floor(cores))
  return { most: Math.max(1, Math.floor(n / 6)), loadAbove: Math.round(n * 0.75 * 100) / 100, waitMs: 10 * 60_000 }
}

/** The queue in the order it starts in, without the load: priority, then rank, then id. */
export function ordered<T extends Waiting>(waiting: readonly T[]): T[] {
  return [...waiting].sort((a, b) => a.pri - b.pri || a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** How many may run at once of the kind `kind` counts against, and how many of it run now; null when it has no limit of its own. */
export function kindRoom(kind: string | undefined, running: readonly Running[], capacity: Capacity): { limit: Limited; most: number; now: number } | null {
  const limit = kind ? limitOf(kind) : null
  const most = limit ? capacity.perKind?.[limit] : undefined
  if (!limit || !most || most <= 0) return null
  return { limit, most, now: running.filter((one) => limitOf(one.kind) === limit).length }
}

const full = (one: Waiting, running: readonly Running[], capacity: Capacity) => {
  const room = kindRoom(one.kind, running, capacity)
  return !!room && room.now >= room.most
}

/** `running` as a count (what callers before per-kind limits passed) or as the runs, by kind. */
const asRuns = (running: number | readonly Running[]): readonly Running[] => (typeof running === 'number' ? Array.from({ length: running }, () => ({ kind: '' })) : running)

export type Decision = { start: string; overdue: boolean } | { start: null; why: string }

export function decide(waiting: readonly Waiting[], running: number | readonly Running[], load: number, now: number, capacity: Capacity): Decision {
  const runs = asRuns(running)
  if (!waiting.length) return { start: null, why: 'Nothing is waiting.' }
  if (runs.length >= capacity.most) return { start: null, why: `${runs.length} running, and ${capacity.most} at once is the most.` }
  const queue = ordered(waiting).filter((one) => !full(one, runs, capacity))
  if (!queue.length) return { start: null, why: 'Every waiting run\'s kind is running as many at once as it may.' }
  if (!(load > capacity.loadAbove)) return { start: queue[0]!.id, overdue: false }
  const overdue = queue.filter((one) => now - one.queuedAt >= capacity.waitMs).sort((a, b) => a.queuedAt - b.queuedAt || a.rank - b.rank)
  if (overdue.length) return { start: overdue[0]!.id, overdue: true }
  return { start: null, why: `The machine's load is ${load.toFixed(1)}, above ${capacity.loadAbove.toFixed(1)}.` }
}

/**
 * Why one waiting run has not started, in a sentence a person or an agent reads: its place, and what
 * it waits for. `position` counts from 1.
 */
export function waitingSaid(id: string, waiting: readonly Waiting[], running: number | readonly Running[], load: number, now: number, capacity: Capacity): string {
  const runs = asRuns(running)
  const queue = ordered(waiting)
  const at = queue.findIndex((one) => one.id === id)
  if (at < 0) return ''
  const me = queue[at]!
  const ahead = at === 0 ? 'Next' : `${at + 1}${ordinal(at + 1)} in the queue`
  if (runs.length >= capacity.most) return `${ahead}: waiting for one of the ${runs.length} running to finish (${capacity.most} at once).`
  const room = kindRoom(me.kind, runs, capacity)
  if (room && room.now >= room.most) {
    const words = KIND_WORDS[room.limit as Kind]
    return `${ahead}: waiting for the ${room.now === 1 ? `${words} run` : `${room.now} ${words} runs`} running to finish (${room.most} ${words} at once).`
  }
  if (load > capacity.loadAbove) {
    const anyway = Math.max(0, me.queuedAt + capacity.waitMs - now)
    return `${ahead}: the machine's load is ${load.toFixed(1)}, above ${capacity.loadAbove.toFixed(1)}; starts when it falls, or in ${minutes(anyway)} anyway.`
  }
  return `${ahead}.`
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return 'th'
  return n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
}

export function minutes(ms: number): string {
  const m = Math.ceil(ms / 60_000)
  return m <= 1 ? 'a minute' : `${m} minutes`
}

export type Move = 'up' | 'down' | 'top'

/**
 * Where a waiting run goes when the person moves it: its new priority and rank, so that it sits just
 * before (up, top) or just after (down) its neighbour in `ordered`. Null when it cannot move that way.
 */
export function moved(waiting: readonly Waiting[], id: string, to: Move): { pri: number; rank: number } | null {
  const queue = ordered(waiting)
  const at = queue.findIndex((one) => one.id === id)
  if (at < 0) return null
  if (to === 'top' || to === 'up') {
    if (at === 0) return null
    const target = to === 'top' ? 0 : at - 1
    const after = queue[target]!
    const before = target > 0 ? queue[target - 1]! : null
    const rank = before && before.pri === after.pri ? (before.rank + after.rank) / 2 : after.rank - 1
    return { pri: after.pri, rank }
  }
  if (at === queue.length - 1) return null
  const before = queue[at + 1]!
  const after = at + 2 < queue.length ? queue[at + 2]! : null
  const rank = after && after.pri === before.pri ? (before.rank + after.rank) / 2 : before.rank + 1
  return { pri: before.pri, rank }
}
