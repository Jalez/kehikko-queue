import { answered, ask, subscribe } from 'kehikot-module-protocol/client'

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

export const api: Api = {
  async runs() {
    return overview(answered(await ask<Got>('./api/runs')))
  },
  async output(id, from) {
    const got = answered(await ask<{ text?: string; next?: number; size?: number }>('./api/output', { query: { id, from: String(from) } }))
    return { text: got.text ?? '', next: got.next ?? from, size: got.size ?? 0 }
  },
  changes: (onChange) => subscribe('./api/runs/events', () => onChange(), { probe: true }),
  outputChanges: (id, onChange) => subscribe('./api/output/events', () => onChange(), { query: { id }, probe: true }),
  async cancel(id) {
    return overview(answered(await ask<Got>('./api/act', { body: { op: 'cancel', id } })))
  },
  async release(id) {
    return overview(answered(await ask<Got>('./api/act', { body: { op: 'release', id } })))
  },
  async move(id, to) {
    return overview(answered(await ask<Got>('./api/act', { body: { op: 'move', id, to } })))
  },
}
