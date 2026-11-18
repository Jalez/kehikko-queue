/**
 * What the page reads of the queue, as a DELTA against what it already has. The queue is 300 and more
 * runs of about a kilobyte each, and the page re-reads on every piece of news, which includes every tenth
 * of load: the whole list, over and over, was ~4.7 MB a minute for nothing that had changed. Now the
 * page sends the `token` of the last answer it holds and is sent only what differs from it:
 *
 *   { ok, token, unchanged: true }                      nothing differs: a few bytes (the 304)
 *   { ok, token, full: false, runs, gone, order?, machine?, leases? }   only what changed
 *   { ok, token, full: true, runs, order, machine, leases }             no token, or one forgotten
 *
 * Why not ETag/If-None-Match: the page asks through the host's frame, which sends no validators and
 * reads with `cache: 'no-store'`; a body of its own works the same through every route.
 *
 * Each token names a snapshot of per-part fingerprints (a few bytes a run, in memory only); the last
 * `KEPT` are kept, and a page that is further behind is sent the whole, once. Pure: no clock, no disk.
 */

/** How many answers back a page may be and still get a delta. */
export const KEPT = 16

export interface Part<R, M, L> {
  runs: readonly (R & { id: string })[]
  machine: M
  leases: L
}

export interface Delta<R, M, L> {
  ok: true
  token: number
  full?: boolean
  unchanged?: true
  /** The runs that are new or differ, whole. */
  runs?: R[]
  /** Ids no longer in the queue. */
  gone?: string[]
  /** The ids in the queue's order; only when the order differs. */
  order?: string[]
  machine?: M
  leases?: L
}

interface Snapshot {
  token: number
  runs: Map<string, string>
  order: string
  machine: string
  leases: string
}

export class Feed<R extends { id: string }, M, L> {
  readonly #snapshots: Snapshot[] = []
  #token = 0

  /** The snapshot of `now`: the newest one when nothing differs from it, a new one when something does. */
  #stamp(now: Part<R, M, L>): { snap: Snapshot } {
    const runs = new Map(now.runs.map((run) => [run.id, JSON.stringify(run)] as const))
    const next: Omit<Snapshot, 'token'> = {
      runs,
      order: now.runs.map((run) => run.id).join('\n'),
      machine: JSON.stringify(now.machine),
      leases: JSON.stringify(now.leases),
    }
    const last = this.#snapshots.at(-1)
    if (last && same(last, next)) return { snap: last }
    const snap = { token: ++this.#token, ...next }
    this.#snapshots.push(snap)
    if (this.#snapshots.length > KEPT) this.#snapshots.splice(0, this.#snapshots.length - KEPT)
    return { snap }
  }

  /** The answer for a page that holds `since` (or nothing, or a token this server does not know). */
  read(now: Part<R, M, L>, since: number | null): Delta<R, M, L> {
    const { snap } = this.#stamp(now)
    const was = since === null ? undefined : this.#snapshots.find((one) => one.token === since)
    if (!was) {
      return { ok: true, token: snap.token, full: true, runs: [...now.runs], order: now.runs.map((run) => run.id), machine: now.machine, leases: now.leases }
    }
    if (was === snap) return { ok: true, token: snap.token, unchanged: true }
    const out: Delta<R, M, L> = { ok: true, token: snap.token, full: false }
    out.runs = now.runs.filter((run) => was.runs.get(run.id) !== snap.runs.get(run.id))
    out.gone = [...was.runs.keys()].filter((id) => !snap.runs.has(id))
    if (was.order !== snap.order) out.order = now.runs.map((run) => run.id)
    if (was.machine !== snap.machine) out.machine = now.machine
    if (was.leases !== snap.leases) out.leases = now.leases
    return out
  }
}

const same = (a: Omit<Snapshot, 'token'>, b: Omit<Snapshot, 'token'>): boolean => {
  if (a.order !== b.order || a.machine !== b.machine || a.leases !== b.leases || a.runs.size !== b.runs.size) return false
  for (const [id, fp] of a.runs) if (b.runs.get(id) !== fp) return false
  return true
}

/** What a page holds of the queue, and how it takes an answer. `got` is a `Delta`, or a plain whole answer. */
export interface Held<R, M, L> {
  token: number | null
  runs: Map<string, R>
  order: string[]
  machine: M | null
  leases: L | null
}

export const nothingHeld = <R, M, L>(): Held<R, M, L> => ({ token: null, runs: new Map(), order: [], machine: null, leases: null })

export interface Answer<R, M, L> {
  token?: number
  unchanged?: boolean
  full?: boolean
  runs?: R[]
  gone?: string[]
  order?: string[]
  machine?: M
  leases?: L
}

/**
 * Take an answer into what the page holds. Returns the new holding, or null when the answer cannot be
 * applied (a delta that names an order with a run it was never sent): the page then asks again with no
 * token, and gets the whole.
 */
export function take<R extends { id: string }, M, L>(held: Held<R, M, L>, got: Answer<R, M, L>): Held<R, M, L> | null {
  if (typeof got.token !== 'number') return null
  if (got.unchanged) return held.token === null ? null : { ...held, token: got.token }
  const runs = got.full ? new Map<string, R>() : new Map(held.runs)
  for (const id of got.gone ?? []) runs.delete(id)
  for (const run of got.runs ?? []) runs.set(run.id, run)
  const order = got.order ?? held.order
  if (order.some((id) => !runs.has(id)) || runs.size !== order.length) return null
  const machine = got.machine ?? held.machine
  const leases = got.leases ?? held.leases
  if (!machine || !leases) return null
  return { token: got.token, runs, order, machine, leases }
}

export const viewOf = <R, M, L>(held: Held<R, M, L>): { runs: R[]; machine: M; leases: L } => ({
  runs: held.order.map((id) => held.runs.get(id)!),
  machine: held.machine!,
  leases: held.leases!,
})
