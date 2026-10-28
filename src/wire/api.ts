import { answered, ask } from 'kehikot-module-protocol/client'

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
  async cancel(id) {
    return overview(answered(await ask<{ runs?: RunView[]; machine?: Machine }>('./api/act', { body: { op: 'cancel', id } })))
  },
  async move(id, to) {
    return overview(answered(await ask<{ runs?: RunView[]; machine?: Machine }>('./api/act', { body: { op: 'move', id, to } })))
  },
}
