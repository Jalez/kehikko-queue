import { answered, ask, subscribe } from 'kehikot-module-protocol/client'

import { nothingHeld, take, viewOf, type Answer, type Held } from '../../queue/feed.ts'
import type { RunView } from '../../queue/queue.ts'
import type { LeaseView } from '../../queue/leases.ts'

/** One look at the machine's 1-minute load: `at` in ms since the epoch. */
export interface Sample {
  at: number
  load: number
}

export interface Machine {
  cores: number
  load: number
  most: number
  loadAbove: number
  waitMinutes: number
  /** The load over the last few minutes, oldest first; empty from a server that does not sample. */
  samples?: Sample[]
  /** How many of each limited kind may run at once (0: no limit of its own); absent from an older server. */
  perKind?: Partial<Record<string, number>>
  /** How many dev servers may be leased at once; absent from an older server. */
  leasesMost?: number
}

export interface Overview {
  runs: RunView[]
  /** The dev-server leases: running ones first, then the few that ended lately. */
  leases?: LeaseView[]
  machine: Machine
}

export interface Output {
  text: string
  next: number
  size: number
}

/** This module's own `/api`, as the page calls it. Writes carry the page's ticket (`ask`). */
export interface Api {
  runs(): Promise<Overview>
  output(id: string, from: number): Promise<Output>
  cancel(id: string): Promise<Overview>
  move(id: string, to: 'up' | 'down' | 'top'): Promise<Overview>
  /** Stop a leased dev server. */
  release(id: string): Promise<Overview>
  /**
   * Hear when the queue changed: once as the stream opens (and again each time it reopens — after a
   * drop, or when the page is shown again), then at every change. Never on a clock; closed while the
   * page is hidden. Returns the function that stops it.
   */
  changes(onChange: () => void): () => void
  /** Hear when one run's output grew, the same way. */
  outputChanges(id: string, onChange: () => void): () => void
}

type Got = { runs?: RunView[]; leases?: LeaseView[]; machine?: Machine }
/**
 * What the server answered, as the page's overview. An answer without the runs or the machine is NOT
 * an empty queue: it is the page having lost its source, and reading it as zero runs and zero limits
 * is how the page once showed "0 running, 0 waiting" while runs were running (issue #47). It throws,
 * and the page says it cannot reach the queue.
 */
export const NOT_THE_QUEUE = 'The Queue server answered with something that is not the queue.'
export const overview = (got: Got): Overview => {
  if (!Array.isArray(got.runs) || !got.machine || typeof got.machine !== 'object') throw new Error(NOT_THE_QUEUE)
  return { runs: got.runs, leases: got.leases ?? [], machine: got.machine }
}

/**
 * What this page holds of the queue. A read sends the token of what it holds and is answered with only
 * what differs (`queue/feed.ts`); an answer that cannot be applied, or a server that does not send
 * tokens (an older one), is read again whole. Nothing here is a second source of the queue: it is the
 * last answer, kept so the next one can be small.
 */
let held: Held<RunView, Machine, LeaseView[]> = nothingHeld()

/** One read or act, taken into what is held; the whole queue the page draws. */
async function lookAt<T extends Got & Answer<RunView, Machine, LeaseView[]>>(call: (since: string) => Promise<T>): Promise<Overview> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const got = await call(attempt === 0 && held.token !== null ? String(held.token) : '')
    if (typeof got.token !== 'number') {
      /* An older server answers the whole queue with no token: draw it, and keep nothing. */
      held = nothingHeld()
      return overview(got)
    }
    /* Two reads in flight can come back out of order: an older answer never replaces a newer one. */
    if (held.token !== null && got.token < held.token) return overview(viewOf(held))
    const next = take(held, got)
    if (next) {
      held = next
      return overview(viewOf(held))
    }
    held = nothingHeld()
  }
  throw new Error(NOT_THE_QUEUE)
}

export const api: Api = {
  runs: () => lookAt(async (since) => answered(await ask<Got & Answer<RunView, Machine, LeaseView[]>>('./api/runs', { query: { since } }))),
  async output(id, from) {
    const got = answered(await ask<{ text?: string; next?: number; size?: number }>('./api/output', { query: { id, from: String(from) } }))
    return { text: got.text ?? '', next: got.next ?? from, size: got.size ?? 0 }
  },
  changes: (onChange) => subscribe('./api/runs/events', () => onChange(), { probe: true }),
  outputChanges: (id, onChange) => subscribe('./api/output/events', () => onChange(), { query: { id }, probe: true }),
  cancel: (id) => act({ op: 'cancel', id }),
  release: (id) => act({ op: 'release', id }),
  move: (id, to) => act({ op: 'move', id, to }),
}

const act = (body: Record<string, string>) => lookAt(async (since) => answered(await ask<Got & Answer<RunView, Machine, LeaseView[]>>('./api/act', { body, query: { since } })))
