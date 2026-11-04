/**
 * The strain on this computer over the last few minutes, for the page's chart: the 1-minute load as
 * the queue's own look at it (`tick`, every few seconds) already reads it, kept in memory only. Nothing
 * is written down and nothing new is measured: a module that restarts starts an empty line.
 */

export interface Sample {
  /** ms since the epoch. */
  at: number
  load: number
}

/** How many samples are kept: five minutes at the queue's look every five seconds. */
export const SAMPLES_KEPT = 60

export class Strain {
  readonly #samples: Sample[] = []
  constructor(readonly kept = SAMPLES_KEPT) {}

  /** One look at the load. A load that is not a number is not kept. */
  add(at: number, load: number): void {
    if (!Number.isFinite(load)) return
    this.#samples.push({ at, load: Math.round(load * 100) / 100 })
    if (this.#samples.length > this.kept) this.#samples.splice(0, this.#samples.length - this.kept)
  }

  /** The samples, oldest first. */
  list(): Sample[] {
    return this.#samples.map((one) => ({ ...one }))
  }
}
