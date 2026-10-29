import { DOOR_PLACE_SAYS, manifestSchema, placeDefaults, type DoorPlace, type Manifest } from 'kehikot-module-protocol'
import {
  establishBuild,
  mintTicket,
  personEnv,
  refuseTicket,
  resolveDoorPlace,
  resolveDoorProject,
  settingsDoor,
  type HostHasProjectOptions,
  type Reply,
} from 'kehikot-module-protocol/serve'

import { DECLARED, ID, VERSION } from './manifest.ts'
import { isSkillPath, skillAt, skillDeclarations, serveFrom } from './skills.ts'
import { projectOf, publish } from './store.ts'
import { argvOf, cwdOf, epicOf, kindOf, labelOf, refsOf } from './queue/asks.ts'
import { runEnv } from './queue/env.ts'
import { originFromCwd, originFromPlace } from './queue/origin-find.ts'
import { makeStream, runsChanged, waitingMoved } from './live.ts'
import { logFile } from './queue/runner.ts'
import { cliToken, logsDir, queueDir } from './queue/machine.ts'
import { ended, Queue, type Asker, type Run, type RunView } from './queue/queue.ts'
import { minutes, type Move } from './queue/schedule.ts'
import { SETTINGS, capacityOf, cores, loadNow, readValues, writeValue } from './queue/settings.ts'

/**
 * Every door but the page, as one function (`answer`), plus the queue they all share. The CLI's own
 * door, which needs the request's headers, is `queue/cli-door.ts`, mounted in front of these.
 */

export const TICKET = mintTicket()
export const BUILD = establishBuild({ version: VERSION, dir: import.meta.dirname })
export const MANIFEST: Manifest = manifestSchema.parse({ ...DECLARED, declares: { ...DECLARED.declares, skills: skillDeclarations() } })

export function servingAt(origin: string): void {
  serveFrom(origin)
  const skills = MANIFEST.declares?.skills
  if (skills) skills.splice(0, skills.length, ...skillDeclarations())
}

/** How the door asks the host about a project and a place. The tests replace `fetch`. */
export const ASK: { options: HostHasProjectOptions } = { options: {} }

/** Where the queue keeps its state. Read once: a process has one queue. */
export const DIR = queueDir()

/**
 * How a queue tells the page (`live.ts`): every change of a run, and, after each look at the load,
 * what the waiting runs say when it has moved. The page is told, never left to ask.
 */
export const toldOf = (get: () => Queue | null) => ({
  changed: runsChanged,
  ticked: () => waitingMoved(() => get()?.list().map((run) => run.waiting ?? '').join('\n') ?? ''),
})

/** The one queue of this process. Tests make their own with `new Queue`. */
let held: Queue | null = null
export function queue(): Queue {
  /* The CLI's token is there from the first start, so a hook can get in. */
  if (!held) cliToken(DIR)
  held ??= new Queue({
    dir: DIR,
    capacity: () => capacityOf(readValues(DIR), cores()),
    load: loadNow,
    publish: (project, runs) => {
      publish(project, runs)
    },
    ...toldOf(() => held),
    tickMs: 5000,
  })
  return held
}

/** The page's streams: the queue, and one run's output (`live.ts`). In `vite.config.ts` and `serve.ts` both. */
export const stream = makeStream(
  (id) => (queue().get(id) ? logFile(logsDir(DIR), id) : null),
  (id) => (queue().get(id)?.state === 'running' ? queue().output(id, 0, 0).size : null),
)
/** For tests: use this queue. */
export function useQueue(one: Queue | null): void {
  held = one
}

export const CLI_TOKEN = (): string => cliToken(DIR)

const ok = (body: unknown): Reply => ({ status: 200, body })
const bad = (why: string, status = 400): Reply => ({ status, body: { ok: false, error: why } })
const plain = (text: string, type = 'text/markdown; charset=utf-8'): Reply => ({ status: 200, body: null, raw: { bytes: text, type } })

/**
 * The paths this module's own doors answer. `vite.config.ts` and `serve.ts` both hand this to the
 * protocol's server, so the built server and Vite serve the same paths (0.1.0's built server did not).
 */
export const isOurs = (path: string): boolean => path === '/healthz' || path === '/mcp' || path.startsWith('/api/') || isSkillPath(path)

/* ------------------------------------------------------------------ *
 * The words
 * ------------------------------------------------------------------ */

const at = (ms: number | null) => (ms === null ? '' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19))
const took = (from: number | null, to: number | null) => (from === null || to === null ? '' : `${Math.max(0, Math.round((to - from) / 1000))} s`)

/** One run, in a few lines an agent reads. */
export function runSaid(run: RunView): string {
  const head = `${run.id} — ${JSON.stringify(run.label)} (${run.kind}) — ${run.state}${run.exit !== null ? `, exit ${run.exit}` : ''}`
  const lines = [head, `  from ${run.asker.said}${run.epic ? `, epic ${run.epic}` : ''}${run.refs.length ? `, for ${run.refs.join(', ')}` : ''}`]
  lines.push(`  in ${run.cwd}: ${run.argv.join(' ').slice(0, 200)}`)
  if (run.state === 'queued') lines.push(`  ${run.waiting ?? 'Waiting.'} Asked ${at(run.queuedAt)}.`)
  if (run.state === 'running') lines.push(`  Running since ${at(run.startedAt)} (waited ${took(run.queuedAt, run.startedAt)}${run.overdue ? ', started past the load guard after its longest wait' : ''}).`)
  if (ended(run.state)) lines.push(`  Ended ${at(run.finishedAt)}: waited ${took(run.queuedAt, run.startedAt ?? run.finishedAt)}, ran ${took(run.startedAt, run.finishedAt) || '0 s'}.${run.why ? ` ${run.why}` : ''}`)
  return lines.join('\n')
}

/** What came of an ended run, with the end of its output: more of it for a failure. */
export function resultSaid(q: Queue, run: Run): string {
  const view = q.view(run)
  if (!ended(run.state)) return `${runSaid(view)}\nNot finished yet: call queue_wait again with the same id.`
  const tail = q.tail(run.id, run.state === 'passed' ? 15 : 80)
  return `${runSaid(view)}\n${tail ? `The end of its output:\n${tail}` : 'It printed nothing.'}`
}

/* ------------------------------------------------------------------ *
 * The MCP door
 * ------------------------------------------------------------------ */

const PLACE_ARGS = {
  project: { type: 'string', description: 'The absolute folder of the Kehikot project the run is for. Optional when this conversation has a place.' },
  epic: { type: 'string', description: 'The epic, as its slug. Optional when this conversation has a place.' },
}

export function tools() {
  return [
    {
      name: 'queue_run',
      description:
        'Put a heavy run (a whole test suite, a typecheck of a monorepo) in this computer\'s one queue instead of starting it now, '
        + 'so runs from several sessions do not starve each other. Test runs starts it when there is room — at most a few at once, '
        + 'and not while the machine is busy (but never later than its longest wait) — in its own process, in `cwd`, with the '
        + 'person\'s login shell environment, and keeps its output. Answers an id and a key at once; then call queue_wait with the id '
        + 'to wait for the result instead of polling the machine\'s load. Its pass or fail is the command\'s own exit code. '
        + 'kind: push (a hook a person waits on) goes first; verify and review are background. ref: the change or issue it is for '
        + '("!3907", "gh#12"), so a checklist of that work can show whether the tests pass.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            description: 'What to run: an array of words (["bun", "test"]), run as is, or one line for the person\'s login shell ("bun run typecheck && bun test").',
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          cwd: { type: 'string', description: 'The absolute folder to run it in (a worktree, say). Default: the project of this conversation\'s place.' },
          kind: { type: 'string', enum: ['push', 'verify', 'review', 'other'], description: 'What it is for. Default other.' },
          label: { type: 'string', description: 'What a person calls this run: "pre-push monorepo", "bun test". Default: the command.' },
          ref: { description: 'The change or issue it is for, spelled as the tracker reading does: "!3907", "gh#12". One, or a list.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          ...PLACE_ARGS,
        },
        required: ['command'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: 'queue_status',
      description:
        'What is in this computer\'s test queue: every run waiting (in the order they start, and what each waits for), running, '
        + 'and recently finished, with the session and epic each came from. With id, one run.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'One run\'s id, from queue_run.' } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'queue_wait',
      description:
        'Wait for one run to finish, up to timeout_seconds (default 240, at most 1800), and answer its result: passed or failed, '
        + 'the exit code, how long it waited and ran, and the end of its output (more of it when it failed). A run still going '
        + 'when the time is up says so; call queue_wait again with the same id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The run\'s id, from queue_run.' }, timeout_seconds: { type: 'number', description: 'How long to wait, in seconds.' } },
        required: ['id'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'queue_cancel',
      description:
        'Cancel one of YOUR runs: waiting ones never start, a running one is stopped with its whole process group. Yours is one '
        + 'asked for by this conversation\'s place, or one whose key (from queue_run) you pass. The person cancels any run on the Test runs page.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The run\'s id.' }, key: { type: 'string', description: 'The key queue_run answered, when this conversation has no place.' } },
        required: ['id'],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ]
}

/** Who an MCP call is, from its place: the words a person reads, and the token it can be known by again. */
export function mcpAsker(place: DoorPlace | null, token: string | null): Asker {
  if (!place) return { via: 'mcp', said: 'an agent session with no place', token: null, conversation: null }
  const where = `${place.projectName ?? place.project}${place.epic ? ` › ${place.epic}` : ''}${place.kehikko?.name ? ` on "${place.kehikko.name}"` : ''}`
  return {
    via: 'mcp',
    said: `an agent session${place.conversation ? ` (${place.conversation.slice(0, 8)})` : ''} in ${where}`,
    token,
    conversation: place.conversation ?? null,
  }
}

/**
 * The environment an agent's run gets: this module's own as the person's (`personEnv`, without the
 * host's own `bun` first on its PATH and `BUN_BE_BUN`), less secrets and Kehikot's plumbing. A login
 * shell adds the person's PATH.
 */
export function agentEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const made = runEnv(personEnv(env), [], true)
  return 'env' in made ? made.env : {}
}

async function call(name: string, args: Record<string, unknown>, query: URLSearchParams, q: Queue): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.slice(0, 64) : null
  const token = query.get('kehikot-place')

  if (name === 'queue_status') {
    if (id) {
      const run = q.get(id)
      if (!run) throw new Error(`There is no run ${id}. queue_status without id lists them.`)
      return runSaid(q.view(run))
    }
    const all = q.list()
    const waiting = all.filter((run) => run.state === 'queued')
    const running = all.filter((run) => run.state === 'running')
    const finished = all.filter((run) => ended(run.state)).slice(0, 15)
    const cap = capacityOf(readValues(DIR), cores())
    const head = `This computer: ${cores()} cores, 1-minute load ${loadNow().toFixed(1)}. At most ${cap.most} at once; nothing new starts above load ${cap.loadAbove.toFixed(1)} until a run has waited ${minutes(cap.waitMs)}.`
    const part = (title: string, runs: RunView[]) => `${title} (${runs.length}):${runs.length ? `\n${runs.map(runSaid).join('\n')}` : ' none.'}`
    return [head, part('Waiting', waiting), part('Running', running), part('Finished lately', finished)].join('\n\n')
  }

  if (name === 'queue_wait') {
    if (!id) throw new Error('queue_wait takes id: the run\'s id, from queue_run.')
    const seconds = args.timeout_seconds === undefined ? 240 : Number(args.timeout_seconds)
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('timeout_seconds is a number of seconds.')
    const run = await q.wait(id, Math.min(seconds, 1800) * 1000)
    if (!run) throw new Error(`There is no run ${id}.`)
    return resultSaid(q, run)
  }

  if (name === 'queue_cancel') {
    if (!id) throw new Error('queue_cancel takes id.')
    const refused = q.cancel(id, { key: typeof args.key === 'string' ? args.key : null, token })
    if (refused) throw new Error(refused)
    return `Cancelled ${id}.`
  }

  if (name === 'queue_run') {
    const place = await resolveDoorPlace(query, ASK.options)
    const named = placeDefaults(args, place)
    let project: string | null = null
    if (named.project && place && named.project === place.project) project = place.project
    else if (named.project) {
      const found = await resolveDoorProject(named.project, ASK.options)
      if (!found.ok) throw new Error(found.why)
      project = found.path
    }
    const cwd = cwdOf(args.cwd ?? project ?? undefined)
    if (!cwd.ok) throw new Error(args.cwd === undefined && !project ? `${DOOR_PLACE_SAYS.unplaced} Or pass cwd: the folder to run it in.` : cwd.why)
    const argv = argvOf(args.command, process.env.SHELL || '/bin/sh')
    if (!argv.ok) throw new Error(argv.why)
    const kind = kindOf(args.kind)
    if (!kind.ok) throw new Error(kind.why)
    const label = labelOf(args.label, argv.value)
    if (!label.ok) throw new Error(label.why)
    const refs = refsOf(args.ref ?? args.refs)
    if (!refs.ok) throw new Error(refs.why)
    const epic = epicOf(named.epic)
    const origin = place ? originFromPlace(place, cwd.value) : await originFromCwd(cwd.value, epic, ASK.options)
    const run = q.enqueue({
      argv: argv.value,
      cwd: cwd.value,
      env: agentEnv(),
      kind: kind.value,
      label: label.value,
      refs: refs.value,
      epic,
      project: project ?? projectOf(cwd.value),
      asker: mcpAsker(place, place ? token : null),
      origin,
    })
    const view = q.view(run)
    return [
      `Queued ${run.id} (key ${run.key}). ${view.state === 'running' ? 'It started at once.' : (view.waiting ?? '')}`,
      `Call queue_wait with id ${run.id} for its result.${place ? '' : ' Keep the key: without a place, it is how queue_cancel knows the run is yours.'}`,
      DOOR_PLACE_SAYS.used(named.from, place),
    ].filter(Boolean).join('\n')
  }

  throw new Error(`There is no tool "${name.slice(0, 60)}" here. This door has queue_run, queue_status, queue_wait and queue_cancel.`)
}

interface Rpc {
  id?: number | string
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

export async function mcp(rpc: Rpc, query: URLSearchParams, q: Queue = queue()): Promise<Reply> {
  const reply = (result: unknown) => ok({ jsonrpc: '2.0', id: rpc.id ?? null, result })
  const text = (said: string, isError = false) => reply({ content: [{ type: 'text', text: said }], ...(isError ? { isError } : {}) })
  if (rpc.method === 'initialize') {
    return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: ID, version: VERSION }, instructions: MANIFEST.mcp?.about ?? '' })
  }
  if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/')) return { status: 202, body: null }
  if (rpc.method === 'tools/list') return reply({ tools: tools() })
  if (rpc.method === 'tools/call') {
    try {
      return text(await call(String(rpc.params?.name ?? ''), rpc.params?.arguments ?? {}, query, q))
    } catch (error) {
      return text(error instanceof Error ? error.message : String(error), true)
    }
  }
  return { status: 404, body: { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: -32601, message: String(rpc.method) } } }
}

/* ------------------------------------------------------------------ *
 * The doors
 * ------------------------------------------------------------------ */

const settings = settingsDoor({
  module: ID,
  fields: SETTINGS,
  read: () => ({ values: readValues(DIR) }),
  write: (_project, key, value) => writeValue(DIR, key, value),
  ticket: TICKET,
})

/** What the page reads: every run, and the machine as the queue sees it. */
export function overview(q: Queue) {
  const capacity = capacityOf(readValues(DIR), cores())
  return { ok: true, runs: q.list(), machine: { cores: cores(), load: loadNow(), most: capacity.most, loadAbove: capacity.loadAbove, waitMinutes: capacity.waitMs / 60_000 } }
}

export async function answer(
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  ticket: string | null,
  q: Queue = queue(),
): Promise<Reply | null> {
  if (path === '/healthz') return ok({ ok: true, id: ID, version: VERSION })

  const skill = method === 'GET' ? skillAt(path) : null
  if (skill) return plain(skill.text)

  const said = await settings(method, path, query, body, ticket)
  if (said) return said

  if (path === '/mcp') {
    if (method !== 'POST') return bad('The MCP door takes POST.', 405)
    if (!body || typeof body.method !== 'string') return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a request' } } }
    return mcp(body as Rpc, query, q)
  }

  if (path === '/api/runs' && method === 'GET') return ok(overview(q))

  if (path === '/api/output' && method === 'GET') {
    const id = query.get('id') ?? ''
    if (!q.get(id)) return bad('There is no such run.', 404)
    const from = Number(query.get('from') ?? 0)
    return ok({ ok: true, ...q.output(id, Number.isFinite(from) && from >= 0 ? from : 0) })
  }

  /* The whole log, as text: for "Open full log" when the drawer shows only the end of it. */
  if (path === '/api/log' && method === 'GET') {
    const id = query.get('id') ?? ''
    if (!q.get(id)) return bad('There is no such run.', 404)
    const size = q.output(id, 0, 0).size
    return plain(q.output(id, 0, Math.max(size, 1)).text, 'text/plain; charset=utf-8')
  }

  if (path === '/api/act' && method === 'POST') {
    /* The person's: only this module's own page, with the ticket it was served. */
    const refused = refuseTicket(ticket, TICKET)
    if (refused) return refused
    const id = typeof body?.id === 'string' ? body.id : ''
    if (body?.op === 'cancel') {
      const no = q.cancel(id, { person: true })
      return no ? bad(no) : ok(overview(q))
    }
    if (body?.op === 'move' && (body.to === 'up' || body.to === 'down' || body.to === 'top')) {
      const no = q.move(id, body.to as Move)
      return no ? bad(no) : ok(overview(q))
    }
    return bad('An act is cancel (id) or move (id, to: up, down or top).')
  }

  if (path.startsWith('/api/')) return bad('Not here.', 404)
  return null
}
