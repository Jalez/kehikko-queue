import { resolveDoorPlace, sameTicket, type Before, type HostHasProjectOptions } from 'kehikot-module-protocol/serve'

import { argvOf, cwdOf, epicOf, kindOf, labelOf, refsOf } from './asks.ts'
import { runEnv } from './env.ts'
import { originFromCwd, originFromPlace } from './origin-find.ts'
import { ended, type Asker, type Queue } from './queue.ts'
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
 *    POST /api/queue/run     { argv, cwd, env, keepEnv?, kind?, label?, refs?, epic?, place?, from? } → { ok, id, key }
 *    GET  /api/queue/follow  ?id=&from=  → one JSON object per line: { run } as it changes, { out } as
 *                            output arrives (from byte `from`), and last { end: run } when it ended.
 *    POST /api/queue/cancel  { id, key }
 */

export const TOKEN_HEADER = 'x-kehikot-queue-token'
const BODY_MOST = 1024 * 1024

const refuse = (status: number, error: string) => Response.json({ ok: false, error }, { status })

export interface CliDoorOptions {
  queue(): Queue
  token(): string
  /** How the place of a token is asked of the host. Read per request, so a test can change it. */
  ask?: () => HostHasProjectOptions
  /** How often a follow looks again, in ms. */
  everyMs?: number
}

export function cliDoor(options: CliDoorOptions): Before {
  return async (request, { asker, url }) => {
    const path = url.pathname
    /* The agent door runs commands too: only programs reach it. */
    if (path === '/mcp' && request.method === 'POST' && asker !== 'program') {
      return refuse(403, 'This door runs commands, so it answers programs on this computer only, never a page.')
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
      const token = typeof body.place === 'string' ? body.place : null
      const place = token ? await resolveDoorPlace(token, options.ask?.() ?? {}) : null
      const from = typeof body.from === 'string' ? body.from.trim().slice(0, 80) : ''
      const asked: Asker = {
        via: 'cli',
        said: `${from || 'a shell'}${place ? ` in ${place.projectName ?? place.project}${place.epic ? ` › ${place.epic}` : ''}` : ''}, in ${cwd.value}`,
        token: place ? token : null,
        conversation: place?.conversation ?? null,
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
      })
      return Response.json({ ok: true, id: run.id, key: run.key, dropped: env.dropped, run: q.view(run) })
    }

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
