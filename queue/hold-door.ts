import { LIMITS, workHoldParams } from 'kehikot-module-protocol'
import { vouchHost, type Before } from 'kehikot-module-protocol/serve'

import type { Queue } from './queue.ts'

/**
 * Where the host asks this queue to hold an app restart behind the runs ahead of it (protocol 2.110.0,
 * `work.queue` `hold`). Only the host may: the call is vouched for by the host (`vouchHost`) before its
 * body is read. A second hold takes over the one waiting. Not held when nothing runs or waits: the host
 * restarts now.
 */
export const HOLD_PATH = '/api/hold'

/** The largest body read: a token and a label. */
const BODY_MOST = 4 * 1024

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

export interface HoldDoorOptions {
  queue(): Queue
  /** Default `vouchHost`. Tests pass their own. */
  vouch?: (headers: Headers) => Promise<{ ok: true } | { ok: false; why: string }>
}

export function holdDoor(options: HoldDoorOptions): Before {
  return async (request, { url }) => {
    if (url.pathname !== HOLD_PATH) return undefined
    if (request.method !== 'POST') return json({ ok: false, error: 'this door takes POST' }, 405)
    const vouched = await (options.vouch ?? ((headers: Headers) => vouchHost(headers)))(request.headers)
    if (!vouched.ok) return json({ ok: false, error: vouched.why }, 403)
    let body: unknown
    try {
      const text = await request.text()
      if (text.length > BODY_MOST) return json({ ok: false, error: 'that body is too large' }, 413)
      body = JSON.parse(text)
    } catch {
      return json({ ok: false, error: 'the body must be JSON' }, 400)
    }
    const parsed = workHoldParams.safeParse(body)
    if (!parsed.success) return json({ ok: false, error: 'that is not a hold: { token, reason, label }' }, 400)
    const label = parsed.data.label.slice(0, LIMITS.RUN_LABEL)
    const said = options.queue().hold(parsed.data.token, label, { via: 'mcp', said: 'Kehikot itself', token: null, conversation: null })
    return json({ held: said.held, ahead: said.ahead, why: '' })
  }
}
