import { resolveDoorPlace, sameTicket, type Before, type HostHasProjectOptions } from 'kehikot-module-protocol/serve'

import { argvOf, cwdOf, epicOf, expectOf, kindOf, labelOf, refsOf } from './asks.ts'
import { runEnv } from './env.ts'
import { originFromCwd, originFromPlace } from './origin-find.ts'
import { checkFolder, preflightRefusal, wouldFail } from './preflight.ts'
import { ended, type Asker, type Queue } from './queue.ts'
import { rangeOf, TTL_DEFAULT_MS, type Leases } from './leases.ts'
import { projectOf } from '../store.ts'

/**
 * The CLI's door (`bin/kehikot-queue`, which a git hook runs), and the fence in front of `/mcp`.
 * Asked before the protocol's doors because it needs what they do not hand on: the headers.
 *
 * This is a door that RUNS COMMANDS, so it is strict:
 *  - Only a program: a request a browser sent (any `Origin`, any `Sec-Fetch-Site`) is refused,
 *    from this module's own page as much as from any other. The `Host` is this machine's, or the
 *    server refused it already (Vite's `allowedHosts`, `run`'s `hostFence`).
 *  - Only with the token in `<queue dir>/token`, a file only this user can read: a program that
 *    has it could have run the command itself.
 *  - The body is JSON (the doors' rule) and bounded; the command is an argv, run as given.
 *
 *    POST /api/queue/run     { argv, cwd, env, keepEnv?, kind?, label?, refs?, epic?, place?, from?, expect?, preflight?, checks? }
 *                            → { ok, id, key, warn }, or { ok: false, refused: true, error } when the folder is not ready
 *                            (its preflight failed, or a built-in check says it would fail): not queued, and not to be
 *                            run outside the queue either.
 *    GET  /api/queue/follow  ?id=&from=  → one JSON object per line: { run } as it changes, { out } as
 *                            output arrives (from byte `from`), and last { end: run } when it ended.
 *    POST /api/queue/cancel  { id, key }
 *    POST /api/queue/lease   { argv, cwd, env, keepEnv?, label?, range?, ttlMinutes?, session?, agent?, holder?, sessionPid?, place?, from? }
 *                            → { ok, id, key, port }, or { ok: false, error } when no slot or port is free
 *    GET  /api/queue/lease/follow ?id=&from= → { lease } as it changes, { out }, and last { end: lease }
 *    POST /api/queue/lease/release { id, key }
 */

export const TOKEN_HEADER = 'x-kehikot-queue-token'
const BODY_MOST = 1024 * 1024

const refuse = (status: number, error: string) => Response.json({ ok: false, error }, { status })

export interface CliDoorOptions {
  queue(): Queue
  token(): string
  /** The dev-server leases; absent: this door leases none. */
  leases?(): Leases
  /** How the place of a token is asked of the host. Read per request, so a test can change it. */
  ask?: () => HostHasProjectOptions
  /** How often a follow looks again, in ms. */
  everyMs?: number
  /**
   * The MCP door, for a `queue_wait` call this door answers as a stream (`waitCall`): `tick` is told
   * how the run stands every so often, and throws once the caller has gone, which ends the wait.
   */
  mcp?: (rpc: McpCall, query: URLSearchParams, tick: (said: string) => void) => Promise<{ status: number; body: unknown }>
}

/** A JSON-RPC call to `/mcp`, as far as this door reads it. */
export interface McpCall {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown>; _meta?: { progressToken?: string | number } }
}

/** The caller of a streamed `queue_wait` went away: the wait ends, and so does its watch. */
export class CallerGone extends Error {}

/**
 * A `queue_wait` call (issue #27), answered as a stream so that the wait ends when its caller goes
 * away: a client that gives up on a long tool call must not keep the run "watched", or its end would
 * not be told to the session as a notice. A client that takes server-sent events and sent a
 * `progressToken` is sent `notifications/progress` while it waits (where the run stands), so a
 * client that resets its timeout on progress keeps the call; any other is sent the one JSON answer.
 */
export async function waitCall(request: Request, query: URLSearchParams, mcp: NonNullable<CliDoorOptions['mcp']>): Promise<Response | undefined> {
  let rpc: McpCall
  try {
    const text = await request.clone().text()
    if (text.length > BODY_MOST) return undefined
    rpc = JSON.parse(text) as McpCall
  } catch {
    return undefined
  }
  if (!rpc || rpc.method !== 'tools/call' || rpc.params?.name !== 'queue_wait') return undefined
  const token = rpc.params?._meta?.progressToken
  const events = (request.headers.get('accept') ?? '').includes('text/event-stream')
  const progress = events && (typeof token === 'string' || typeof token === 'number') ? token : null
  const encoder = new TextEncoder()
  let gone = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (message: unknown) => controller.enqueue(encoder.encode(events ? `event: message\ndata: ${JSON.stringify(message)}\n\n` : JSON.stringify(message)))
      let step = 0
      const tick = (said: string) => {
        if (gone) throw new CallerGone()
        if (progress === null) return
        step += 1
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: progress, progress: step, message: said } })
      }
      try {
        const reply = await mcp(rpc, query, tick)
        if (!gone) send(reply.body)
      } catch {
        /* The caller went away; nobody to answer. */
      } finally {
        try {
          controller.close()
        } catch {
          /* The reader went away. */
        }
      }
    },
    cancel() {
      gone = true
    },
  })
  return new Response(stream, { headers: { 'content-type': events ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store' } })
}

export function cliDoor(options: CliDoorOptions): Before {
  return async (request, { asker, url }) => {
    const path = url.pathname
    /* The agent door runs commands too: only programs reach it. */
    if (path === '/mcp' && request.method === 'POST' && asker !== 'program') {
      return refuse(403, 'This door runs commands, so it answers programs on this computer only, never a page.')
    }
    if (path === '/mcp' && request.method === 'POST' && options.mcp) {
      const waited = await waitCall(request, url.searchParams, options.mcp)
      if (waited) return waited
    }
    if (!path.startsWith('/api/queue/')) return undefined
    if (asker !== 'program' || request.headers.get('origin') !== null || request.headers.get('sec-fetch-site') !== null) {
      return refuse(403, 'This door runs commands, so it answers programs on this computer only, never a page.')
    }
    if (!sameTicket(request.headers.get(TOKEN_HEADER), options.token())) {
      return refuse(403, 'This door needs the token from the queue\'s folder, which only programs of this user on this computer can read.')
    }
    const q = options.queue()

    if (path === '/api/queue/run' && request.method === 'POST') {
      const body = await jsonOf(request)
      if (!body) return refuse(400, 'The body is a JSON object, at most 1 MB, sent as application/json.')
      const argv = argvOf(body.argv, '/bin/sh')
      if (!argv.ok || !Array.isArray(body.argv)) return refuse(400, argv.ok ? 'argv is the command as an array of words.' : argv.why)
      const cwd = cwdOf(body.cwd)
      if (!cwd.ok) return refuse(400, cwd.why)
      const keep = Array.isArray(body.keepEnv) ? body.keepEnv.filter((one): one is string => typeof one === 'string').slice(0, 64) : []
      const env = runEnv(body.env, keep)
      if ('why' in env) return refuse(400, env.why)
      const kind = kindOf(body.kind)
      if (!kind.ok) return refuse(400, kind.why)
      const label = labelOf(body.label, argv.value)
      if (!label.ok) return refuse(400, label.why)
      const refs = refsOf(body.refs)
      if (!refs.ok) return refuse(400, refs.why)
      const expect = expectOf(body.expect)
      if (!expect.ok) return refuse(400, expect.why)
      /* Is the folder ready? Said now, not after the wait (issue #28). */
      if (body.preflight !== undefined && body.preflight !== null) {
        const pre = argvOf(body.preflight, '/bin/sh')
        if (!pre.ok || !Array.isArray(body.preflight)) return refuse(400, pre.ok ? 'preflight is a command as an array of words.' : `preflight: ${pre.why}`)
        const refused = await preflightRefusal(pre.value, cwd.value, env.env)
        if (refused) return Response.json({ ok: false, refused: true, error: refused }, { status: 422 })
      }
      const checked = body.checks === false ? { refuse: [], warn: [] } : await checkFolder(cwd.value, env.env)
      if (checked.refuse.length) {
        return Response.json({ ok: false, refused: true, error: ['Not queued: it would fail before it did anything.', ...wouldFail(checked.refuse), 'Fix that and ask again, or pass --no-checks to queue it anyway.'].join('\n') }, { status: 422 })
      }
      const token = typeof body.place === 'string' ? body.place : null
      const place = token ? await resolveDoorPlace(token, options.ask?.() ?? {}) : null
      const from = typeof body.from === 'string' ? body.from.trim().slice(0, 80) : ''
      const asked: Asker = {
        via: 'cli',
        said: `${from || 'a shell'}${place ? ` in ${place.projectName ?? place.project}${place.epic ? ` › ${place.epic}` : ''}` : ''}, in ${cwd.value}`,
        token: place ? token : null,
        conversation: place?.conversation ?? null,
        ...whoOf(body),
      }
      const epic = epicOf(body.epic) ?? place?.epic ?? null
      const origin = place ? originFromPlace(place, cwd.value) : await originFromCwd(cwd.value, epic, options.ask?.() ?? {})
      const run = q.enqueue({
        argv: argv.value,
        cwd: cwd.value,
        env: env.env,
        kind: kind.value,
        label: label.value,
        refs: refs.value,
        epic,
        project: place?.project ?? projectOf(cwd.value),
        asker: asked,
        origin,
        expect: expect.value,
      })
      return Response.json({ ok: true, id: run.id, key: run.key, dropped: env.dropped, warn: wouldFail(checked.warn), run: q.view(run) })
    }

    if (path.startsWith('/api/queue/lease')) return leaseDoor(request, url, options)

    if (path === '/api/queue/cancel' && request.method === 'POST') {
      const body = await jsonOf(request)
      const refused = q.cancel(String(body?.id ?? ''), { key: typeof body?.key === 'string' ? body.key : null })
      return refused ? refuse(400, refused) : Response.json({ ok: true })
    }

    if (path === '/api/queue/follow' && request.method === 'GET') {
      const id = url.searchParams.get('id') ?? ''
      if (!q.get(id)) return refuse(404, 'There is no such run.')
      let from = Math.max(0, Number(url.searchParams.get('from') ?? 0) || 0)
      const every = options.everyMs ?? 500
      const encoder = new TextEncoder()
      let stop = false
      /* Someone follows it: its end is told to them, not as a notice too. Released when the follower goes. */
      const release = q.watch(id)
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const line = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
          let said = ''
          try {
            while (!stop) {
              const run = q.get(id)
              if (!run) break
              const view = q.view(run)
              const now = `${view.state}|${view.position}|${view.waiting}`
              if (now !== said) {
                said = now
                line({ run: view })
              }
              for (;;) {
                const read = q.output(id, from)
                if (!read.text) break
                from = read.next
                line({ out: read.text, next: from })
              }
              if (ended(run.state)) {
                line({ end: view })
                break
              }
              await new Promise((done) => setTimeout(done, every))
            }
          } finally {
            release()
            try {
              controller.close()
            } catch {
              /* The reader went away. */
            }
          }
        },
        cancel() {
          stop = true
          release()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } })
    }

    return refuse(404, 'Not here.')
  }
}

/** The lease paths of the CLI's door: behind the same fence (a program, with the token) as the runs. */
async function leaseDoor(request: Request, url: URL, options: CliDoorOptions): Promise<Response> {
  const leases = options.leases?.()
  if (!leases) return refuse(404, 'This Queue leases no dev servers.')
  const path = url.pathname
  if (path === '/api/queue/lease' && request.method === 'POST') {
    const body = await jsonOf(request)
    if (!body) return refuse(400, 'The body is a JSON object, at most 1 MB, sent as application/json.')
    const argv = argvOf(body.argv, '/bin/sh')
    if (!argv.ok || !Array.isArray(body.argv)) return refuse(400, argv.ok ? 'argv is the command as an array of words.' : argv.why)
    const cwd = cwdOf(body.cwd)
    if (!cwd.ok) return refuse(400, cwd.why)
    const keep = Array.isArray(body.keepEnv) ? body.keepEnv.filter((one): one is string => typeof one === 'string').slice(0, 64) : []
    const env = runEnv(body.env, keep)
    if ('why' in env) return refuse(400, env.why)
    const range = rangeOf(body.range)
    if (!range) return refuse(400, 'range is a port range from 1024 up, "5280-5299".')
    const label = labelOf(body.label, argv.value)
    if (!label.ok) return refuse(400, label.why)
    const minutes = typeof body.ttlMinutes === 'number' && Number.isFinite(body.ttlMinutes) && body.ttlMinutes > 0 ? body.ttlMinutes : TTL_DEFAULT_MS / 60_000
    const token = typeof body.place === 'string' ? body.place : null
    const place = token ? await resolveDoorPlace(token, options.ask?.() ?? {}) : null
    const from = typeof body.from === 'string' ? body.from.trim().slice(0, 80) : ''
    const sessionPid = typeof body.sessionPid === 'number' && Number.isInteger(body.sessionPid) && body.sessionPid > 1 ? body.sessionPid : null
    const taken = await leases.take({
      argv: argv.value,
      cwd: cwd.value,
      env: env.env,
      label: label.value,
      project: place?.project ?? projectOf(cwd.value),
      range,
      ttlMs: minutes * 60_000,
      asker: { via: 'cli', said: `${from || 'a shell'}, in ${cwd.value}`, token: place ? token : null, conversation: place?.conversation ?? null, ...whoOf(body) },
      sessionPid,
    })
    if (typeof taken === 'string') return refuse(409, taken)
    return Response.json({ ok: true, id: taken.id, key: taken.key, port: taken.port, until: taken.until, dropped: env.dropped })
  }
  if (path === '/api/queue/lease/release' && request.method === 'POST') {
    const body = await jsonOf(request)
    const refused = leases.release(String(body?.id ?? ''), { key: typeof body?.key === 'string' ? body.key : null })
    return refused ? refuse(400, refused) : Response.json({ ok: true })
  }
  if (path === '/api/queue/lease/follow' && request.method === 'GET') {
    const id = url.searchParams.get('id') ?? ''
    if (!leases.get(id)) return refuse(404, 'There is no such lease.')
    let from = Math.max(0, Number(url.searchParams.get('from') ?? 0) || 0)
    const every = options.everyMs ?? 500
    const encoder = new TextEncoder()
    let stop = false
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const line = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
        let said = ''
        try {
          while (!stop) {
            const lease = leases.get(id)
            if (!lease) break
            const view = leases.view(lease)
            if (view.state !== said) {
              said = view.state
              line({ lease: view })
            }
            for (;;) {
              const read = leases.output(id, from)
              if (!read.text) break
              from = read.next
              line({ out: read.text, next: from })
            }
            if (lease.state === 'ended') {
              line({ end: view })
              break
            }
            await new Promise((done) => setTimeout(done, every))
          }
        } finally {
          try {
            controller.close()
          } catch {
            /* The reader went away. */
          }
        }
      },
      cancel() {
        stop = true
      },
    })
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } })
  }
  return refuse(404, 'Not here.')
}

/** The asking session, agent and waiting process a CLI says: checked words and a pid, or nothing. */
export function whoOf(body: Record<string, unknown>): Pick<Asker, 'session' | 'agent' | 'holder'> {
  const session = typeof body.session === 'string' && /^[\w.:-]{1,128}$/.test(body.session) ? body.session : null
  const agent = typeof body.agent === 'string' ? body.agent.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) || null : null
  const holder = typeof body.holder === 'number' && Number.isInteger(body.holder) && body.holder > 1 ? body.holder : null
  return { session, agent, holder }
}

async function jsonOf(request: Request): Promise<Record<string, unknown> | null> {
  if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') return null
  const text = await request.text()
  if (text.length > BODY_MOST) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
