import { answered, ask, subscribe } from 'kehikot-module-protocol/client'

import type { RunView } from '../../queue/queue.ts'

export interface Machine {
  cores: number
  load: number
  most: number
  loadAbove: number
  waitMinutes: number
}

export interface Overview {
  runs: RunView[]
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
  /**
   * Hear when the queue changed: once as the stream opens (and again each time it reopens — after a
   * drop, or when the page is shown again), then at every change. Never on a clock; closed while the
   * page is hidden. Returns the function that stops it.
   */
  changes(onChange: () => void): () => void
  /** Hear when one run's output grew, the same way. */
  outputChanges(id: string, onChange: () => void): () => void
}

const overview = (got: { runs?: RunView[]; machine?: Machine }): Overview => ({ runs: got.runs ?? [], machine: got.machine ?? { cores: 0, load: 0, most: 0, loadAbove: 0, waitMinutes: 0 } })

export const api: Api = {
  async runs() {
    return overview(answered(await ask<{ runs?: RunView[]; machine?: Machine }>('./api/runs')))
  },
  async output(id, from) {
    const got = answered(await ask<{ text?: string; next?: number; size?: number }>('./api/output', { query: { id, from: String(from) } }))
    return { text: got.text ?? '', next: got.next ?? from, size: got.size ?? 0 }
  },
  changes: (onChange) => subscribe('./api/runs/events', () => onChange(), { probe: true }),
  outputChanges: (id, onChange) => subscribe('./api/output/events', () => onChange(), { query: { id }, probe: true }),
  async cancel(id) {
    return overview(answered(await ask<{ runs?: RunView[]; machine?: Machine }>('./api/act', { body: { op: 'cancel', id } })))
  },
  async move(id, to) {
    return overview(answered(await ask<{ runs?: RunView[]; machine?: Machine }>('./api/act', { body: { op: 'move', id, to } })))
  },
}
