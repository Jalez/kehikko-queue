import { DOOR_PLACE_SAYS, LIMITS, manifestSchema, placeDefaults, type DoorPlace, type Manifest } from 'kehikot-module-protocol'
import {
  askHost,
  establishBuild,
  mintTicket,
  personEnv,
  refuseTicket,
  resolveDoorPlace,
  resolveDoorProject,
  settingsDoor,
  shortPath,
  type HostHasProjectOptions,
  type Reply,
} from 'kehikot-module-protocol/serve'

import { DECLARED, ID, VERSION } from './manifest.ts'
import { CLI, isSkillPath, skillAt, skillDeclarations, serveFrom } from './skills.ts'
import { projectOf, publish } from './store.ts'
import { argvOf, cwdOf, epicOf, expectOf, kindOf, labelOf, refsOf } from './queue/asks.ts'
import { runEnv } from './queue/env.ts'
import { originFromCwd, originFromPlace } from './queue/origin-find.ts'
import { loadMoved, makeStream, runsChanged, waitingMoved } from './live.ts'
import { Strain } from './queue/strain.ts'
import { logFile } from './queue/runner.ts'
import { cliToken, logsDir, queueDir } from './queue/machine.ts'
import { askedSaid } from './queue/who.ts'
import { ended, Queue, RUN_KINDS, type Asker, type Run, type RunView } from './queue/queue.ts'
import { minutes, type Move } from './queue/schedule.ts'
import { SETTINGS, capacityOf, cores, leasesOf, loadNow, readValues, writeValue } from './queue/settings.ts'
import { leaseSaid, Leases, rangeOf, TTL_DEFAULT_MS } from './queue/leases.ts'
import { KIND_WORDS, LIMITED } from './queue/kinds.ts'
import { guardSettingsOf, guardsFor } from './queue/guards.ts'
import { checkFolder, preflightRefusal, wouldFail } from './queue/preflight.ts'

/**
 * Every door but the page, as one function (`answer`), plus the queue they all share. The CLI's own
 * door, which needs the request's headers, is `queue/cli-door.ts`, mounted in front of these.
 */

export const TICKET = mintTicket()
export const BUILD = establishBuild({ version: VERSION, dir: import.meta.dirname })
/* The guards (protocol 2.61.0) follow the person's settings; read here, and again when one changes. */
const guardsNow = () => guardsFor(CLI, guardSettingsOf(readValues(queueDir())))
export const MANIFEST: Manifest = manifestSchema.parse({ ...DECLARED, guards: guardsNow(), declares: { ...DECLARED.declares, skills: skillDeclarations() } })

export function servingAt(origin: string): void {
  serveFrom(origin)
  const skills = MANIFEST.declares?.skills
  if (skills) skills.splice(0, skills.length, ...skillDeclarations())
}

/** How the door asks the host about a project and a place. The tests replace `fetch`. */
export const ASK: { options: HostHasProjectOptions } = { options: {} }

/** Where the queue keeps its state. Read once: a process has one queue. */
export const DIR = queueDir()

/** The load over the last few minutes, sampled at the queue's own look at it: what the page's strain chart draws. */
export const STRAIN = new Strain()

/**
 * How a queue tells the page (`live.ts`): every change of a run, and, after each look at the load,
 * what the waiting runs say when it has moved. With `load`, that look also samples the load for the
 * strain chart and tells the page when it moved. The page is told, never left to ask.
 */
export const toldOf = (get: () => Queue | null, load?: () => number) => ({
  changed: runsChanged,
  ticked: () => {
    /* Only what the WAITING runs say: a run that is not waiting has none, and counting it would
       tell the page "something moved" on every tick that merely has runs in the list. */
    waitingMoved(() => get()?.list().filter((run) => run.state === 'queued').map((run) => run.waiting ?? '').join('\n') ?? '')
    if (!load) return
    const now = load()
    STRAIN.add(Date.now(), now)
    loadMoved(() => now)
  },
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
    ...toldOf(() => held, loadNow),
    tickMs: 5000,
    ended: (run, watched) => void tellAsker(run, watched),
  })
  return held
}

/** The dev-server leases of this process. Tests make their own with `new Leases`. */
let leasesHeld: Leases | null = null
let leaseTimer: ReturnType<typeof setInterval> | null = null
export function leases(): Leases {
  if (!leasesHeld) {
    leasesHeld = new Leases({ dir: DIR, most: () => leasesOf(readValues(DIR)), changed: runsChanged })
    leaseTimer = setInterval(() => leasesHeld?.tick(), 5000)
    leaseTimer.unref?.()
  }
  return leasesHeld
}
/** For tests: use these leases. */
export function useLeases(one: Leases | null): void {
  if (leaseTimer && one !== leasesHeld) {
    clearInterval(leaseTimer)
    leaseTimer = null
  }
  leasesHeld = one
}

/* ------------------------------------------------------------------ *
 * Telling the asker (protocol 2.54.0, `messages.notify`)
 * ------------------------------------------------------------------ */


/** A word for a POSIX shell, quoted: the CLI's path has spaces on macOS ("Application Support"). */
const quoted = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)

/** The command line that waits on one run and exits with its code (`kehikot-queue wait`). */
export const waitLine = (id: string): string => `${quoted(CLI)} wait ${id}`

/** A span of time as a person says it: "38 s", "4 min 12 s". */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`
}

/**
 * The one line the session that asked is told when its run ends: built only from the run's own
 * fields — label, outcome, exit code, how long, why — the folder's last meaningful segment (`shortPath`),
 * and the tool call that reads its output (`queue_wait <id>`), so the notice stays one short line.
 */
export function noticeFor(run: Pick<Run, 'id' | 'label' | 'state' | 'exit' | 'why' | 'expect' | 'startedAt' | 'finishedAt' | 'cwd'>): string {
  const outcome = run.state === 'passed' ? 'passed' : run.state === 'failed' ? 'failed' : 'was cancelled'
  const exit = run.exit !== null ? ` (exit ${run.exit})` : ''
  const expected = run.expect === 'fail' ? (run.state === 'failed' ? ', as expected' : run.state === 'passed' ? ', but it was expected to fail' : '') : ''
  const ran = run.startedAt !== null && run.finishedAt !== null ? ` after ${span(run.finishedAt - run.startedAt)}` : ''
  const why = run.why ? ` ${run.why}` : ''
  const tail = ` queue_wait ${run.id}`
  const head = `Run ${JSON.stringify(run.label)} ${outcome}${exit}${expected}${ran} — in ${shortPath(run.cwd)}.`
  const room = LIMITS.MESSAGE_BODY - head.length - tail.length
  return `${head}${why.length > room ? `${why.slice(0, Math.max(0, room - 1))}…` : why}${tail}`
}

/**
 * Tell the session that asked how its run came out, when nobody is waiting on it (a `queue_wait`, a
 * CLI following it): Kehikot types it in for an idle session. Only for a run asked with a place token,
 * and only through a host from 2.54.0; anything else is skipped quietly. Never throws.
 */
export async function tellAsker(run: Run, watched: boolean, ask: typeof askHost = askHost): Promise<'told' | 'skipped' | 'refused'> {
  if (watched || !run.asker.token) return 'skipped'
  try {
    const said = await ask('messages.notify', { token: run.asker.token, body: noticeFor(run), kind: 'report' }, { module: ID })
    return said.ok && said.data.outcome === 'sent' ? 'told' : 'refused'
  } catch {
    return 'refused'
  }
}

/** The page's streams: the queue, and one run's output (`live.ts`). In `vite.config.ts` and `serve.ts` both. */
export const stream = makeStream(
  (id) => (queue().get(id) ? logFile(logsDir(DIR), id) : null),
  (id) => (queue().get(id)?.state === 'running' ? queue().output(id, 0, 0).size : null),
)
/** For tests: use this queue. The one it replaces is stopped, so two queues never share the folder. */
export function useQueue(one: Queue | null): void {
  if (held && held !== one) held.stop()
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
  const head = `${run.id} — ${JSON.stringify(run.label)} (${run.kind}) — ${run.state}${run.exit !== null ? `, exit ${run.exit}` : ''}${run.expect === 'fail' ? (run.state === 'failed' ? ', as expected' : run.state === 'passed' ? ', but it was expected to fail' : ', expected to fail') : ''}`
  const lines = [head, `  ${run.position !== null ? `#${run.position} in line, ` : ''}from ${askedSaid(run.asker)}${run.epic ? `, epic ${run.epic}` : ''}${run.refs.length ? `, for ${run.refs.join(', ')}` : ''}`]
  lines.push(`  in ${run.cwd}: ${run.argv.join(' ').slice(0, 200)}`)
  if (run.state === 'queued') lines.push(`  ${run.waiting ?? 'Waiting.'} Asked ${at(run.queuedAt)}.`)
  if (run.state === 'running') lines.push(`  Running since ${at(run.startedAt)} (waited ${took(run.queuedAt, run.startedAt)}${run.overdue ? ', started past the load guard after its longest wait' : ''}).`)
  if (ended(run.state)) lines.push(`  Ended ${at(run.finishedAt)}: waited ${took(run.queuedAt, run.startedAt ?? run.finishedAt)}, ran ${took(run.startedAt, run.finishedAt) || '0 s'}.${run.why ? ` ${run.why}` : ''}`)
  return lines.join('\n')
}

/** The per-kind limits in words: "1 typecheck, 1 e2e tests, 2 tests, 1 build, 2 task at once". */
export function limitsSaid(perKind: Partial<Record<string, number>> | undefined): string {
  const said = LIMITED.filter((kind) => (perKind?.[kind] ?? 0) > 0).map((kind) => `${perKind![kind]} ${KIND_WORDS[kind]}`)
  return said.length ? `of each kind at most ${said.join(', ')}` : 'no limits by kind'
}

/** What `queue_seen`, which 0.6.0 had, answers now: nothing to do, and no error. */
export const SEEN_GONE = 'Nothing to mark: Queue no longer asks the person about results, passed or failed. Each run\'s result stays on the Queue page.'

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
        'Put heavy work — a whole test suite, a typecheck of a monorepo, a build, a big install or any other resource-intensive '
        + 'command — in this computer\'s one queue instead of starting it now, so runs from several sessions do not starve each '
        + 'other. Queue starts it when there is room — at most a few at once, '
        + 'and not while the machine is busy (but never later than its longest wait) — in its own process, in `cwd`, with the '
        + 'person\'s login shell environment, and keeps its output. Answers an id and a key at once, and the command line that waits '
        + 'for it as long as it takes: run that as a BACKGROUND shell command (in Claude Code, Bash with run_in_background) and you '
        + 'are woken when it exits with the run\'s exit code. Or call queue_wait with the id. Do not poll the machine\'s load. Its pass '
        + 'or fail is the command\'s own exit code. A fault in the folder is said at once instead of after the wait: an untrusted mise '
        + 'config refuses the run, a stale node_modules is said as "Would fail", and preflight is your own quick check run first. '
        + 'kind: verify for tests (the default), typecheck for tsc, e2e for browser tests, build for a build, task for any other heavy command; push (a hook a person waits '
        + 'on) goes first, the rest are background. ref: the change or issue it is for ("!3907", "gh#12"), so a checklist of that '
        + 'work can show whether it passes.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            description: 'What to run: an array of words (["bun", "test"]), run as is, or one line for the person\'s login shell ("bun run typecheck && bun test").',
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          cwd: { type: 'string', description: 'The absolute folder to run it in (a worktree, say). Default: the project of this conversation\'s place.' },
          kind: { type: 'string', enum: [...RUN_KINDS], description: 'What it is: verify (tests, the default), typecheck (tsc), e2e (browser tests, Playwright), build, task (any other heavy command), push (a hook somebody waits on, goes first), review. other is the old name of task. Each limited kind has its own limit of how many run at once.' },
          label: { type: 'string', description: 'What a person calls this run: "pre-push monorepo", "bun test". Default: the command.' },
          ref: { description: 'The change or issue it is for, spelled as the tracker reading does: "!3907", "gh#12". One, or a list.', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          preflight: {
            description: 'A quick check run at once in cwd, before the run waits (at most 60 s): "bun install --frozen-lockfile --dry-run", "mise trust --show". If it fails, the run is refused with its output and never waits. Same forms as command.',
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          checks: { type: 'boolean', description: 'false skips the built-in checks of the folder (an untrusted mise config, a stale node_modules). Default true.' },
          expect: {
            type: 'string',
            enum: ['fail'],
            description: '"fail" when the run is MEANT to fail (a red test written before the fix): its failure is then said as "failed as expected", and a pass as "passed, but it was expected to fail". Its exit code is still the command\'s own.',
          },
          ...PLACE_ARGS,
        },
        required: ['command'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: 'queue_status',
      description:
        'What is in this computer\'s queue of heavy work (tests, builds, other commands): every run waiting (its place in line, and what each waits for), running, '
        + 'and recently finished, with who asked (the agent session) and the epic each came from; and the leased dev servers. With id, one run or lease.',
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'One run\'s id, from queue_run.' } } },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'queue_wait',
      description:
        'Wait for one run to finish, up to timeout_seconds (default 240, at most 1800), and answer its result: passed or failed, '
        + 'the exit code, how long it waited and ran, and the end of its output (more of it when it failed). A run still going '
        + 'when the time is up says so; call queue_wait again with the same id. Sends progress notifications while it waits when '
        + 'the call carries a progressToken. To wait as long as a run takes, prefer the command line queue_run answered '
        + '(kehikot-queue wait <id>) as a background shell command.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The run\'s id, from queue_run.' },
          timeout_seconds: { type: 'number', description: 'How long to wait, in seconds.' },
          key: { type: 'string', description: 'The key queue_run answered, when this conversation has no place: it says the result reached the session that asked.' },
        },
        required: ['id'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'queue_lease',
      description:
        'Run a dev server (bun run dev, vite) in one of this computer\'s few leased slots instead of starting it in your shell, so '
        + 'sessions do not each leave one running. Queue picks a free port from port_range, gives it as $PORT and in place of {port} '
        + 'in the command, starts it in a process group of its own, and answers the port at once. It stops the server when you '
        + 'release it (queue_cancel with the lease id), when ttl_minutes runs out (default 30), or when the person stops it. '
        + 'From a shell, `kehikot-queue lease dev -- COMMAND` does the same and also stops it when that command or its session ends.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { description: 'The dev server\'s command: an array of words, or one line for the person\'s login shell ("bun run dev -- --port {port}").', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          cwd: { type: 'string', description: 'The absolute folder to run it in (a worktree, say). Default: the project of this conversation\'s place.' },
          port_range: { type: 'string', description: 'Where to find a free port, "FROM-TO". Default 5280-5299.' },
          ttl_minutes: { type: 'number', description: 'How long the lease lasts, in minutes. Default 30, at most 480.' },
          label: { type: 'string', description: 'What a person calls it. Default: the command.' },
          session: { type: 'string', description: 'Your agent session\'s id, shown with the lease.' },
          ...PLACE_ARGS,
        },
        required: ['command'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: 'queue_cancel',
      description:
        'Cancel one of YOUR runs, or release one of your dev-server leases: waiting ones never start, a running one (or a leased server) is stopped with its whole process group. Yours is one '
        + 'asked for by this conversation\'s place, or one whose key (from queue_run) you pass. The person cancels any run on the Queue page.',
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

/** How often a waiting `queue_wait` says how it stands, in ms. */
export const PROGRESS_EVERY_MS = 15_000

/** Where a run stands, in a few words, for a progress notification. */
export function progressSaid(view: RunView, now = Date.now()): string {
  if (view.state === 'queued') return `Waiting${view.position ? `, ${view.position}${view.position === 1 ? 'st' : view.position === 2 ? 'nd' : view.position === 3 ? 'rd' : 'th'} in line` : ''}: ${view.waiting ?? 'for room'}`
  if (view.state === 'running') return `Running for ${span(now - (view.startedAt ?? now))}.`
  return `${view.state}.`
}

/**
 * Wait for a run up to `ms`, saying how it stands every `every` ms through `tick` (MCP progress).
 * Resolves with the run as it is when it ended or the time ran out; undefined when there is no such run.
 */
export async function waitTelling(q: Queue, id: string, ms: number, tick?: (said: string) => void, every = PROGRESS_EVERY_MS): Promise<Run | undefined> {
  const until = Date.now() + ms
  for (;;) {
    const left = Math.max(0, until - Date.now())
    const run = await q.wait(id, tick ? Math.min(every, left) : left)
    if (!run || ended(run.state) || Date.now() >= until) return run
    tick?.(progressSaid(q.view(run)))
  }
}

/** The lines `queue_run` answers after the run is queued: how to wait on it, and what Kehikot will do. */
export function waitSaid(id: string, placed: boolean): string[] {
  return [
    `To wait for it as long as it takes, run this as a background shell command (Claude Code: Bash with run_in_background: true): ${waitLine(id)}`
    + ' — it prints the run\'s output and exits with its exit code, and you are woken when it exits. Or call queue_wait with id '
    + `${id} (at most 30 min a call; call it again while it is not finished).`,
    placed ? 'If nothing is waiting on it when it ends, Kehikot types a one-line notice of its result into this session (when your person lets messages wake sessions), so you may end your turn.' : '',
  ].filter(Boolean)
}

async function call(name: string, args: Record<string, unknown>, query: URLSearchParams, q: Queue, tick?: (said: string) => void): Promise<string> {
  const id = typeof args.id === 'string' ? args.id.slice(0, 64) : null
  const token = query.get('kehikot-place')

  if (name === 'queue_status') {
    if (id) {
      const lease = leases().get(id)
      if (lease) {
        const tail = leases().tail(id, 40)
        return `${leaseSaid(leases().view(lease))}\n${tail ? `The end of its output:\n${tail}` : 'It printed nothing yet.'}`
      }
      const run = q.get(id)
      if (!run) throw new Error(`There is no run ${id}. queue_status without id lists them.`)
      return runSaid(q.view(run))
    }
    const all = q.list()
    const waiting = all.filter((run) => run.state === 'queued')
    const running = all.filter((run) => run.state === 'running')
    const finished = all.filter((run) => ended(run.state)).slice(0, 15)
    const cap = capacityOf(readValues(DIR), cores())
    const head = `This computer: ${cores()} cores, 1-minute load ${loadNow().toFixed(1)}. At most ${cap.most} at once (${limitsSaid(cap.perKind)}); nothing new starts above load ${cap.loadAbove.toFixed(1)} until a run has waited ${minutes(cap.waitMs)}.`
    const part = (title: string, runs: RunView[]) => `${title} (${runs.length}):${runs.length ? `\n${runs.map(runSaid).join('\n')}` : ' none.'}`
    const leased = leases().list().filter((one) => one.state === 'running')
    const servers = `Dev servers (${leased.length} of ${leasesOf(readValues(DIR))}):${leased.length ? `\n${leased.map((one) => leaseSaid(one)).join('\n')}` : ' none.'}`
    return [head, part('Waiting', waiting), part('Running', running), servers, part('Finished lately', finished)].join('\n\n')
  }

  if (name === 'queue_wait') {
    if (!id) throw new Error('queue_wait takes id: the run\'s id, from queue_run.')
    const seconds = args.timeout_seconds === undefined ? 240 : Number(args.timeout_seconds)
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('timeout_seconds is a number of seconds.')
    if (!q.get(id)) throw new Error(`There is no run ${id}.`)
    /* Someone is waiting on it: its end is told here, not as a notice too. */
    const release = q.watch(id)
    try {
      const run = await waitTelling(q, id, Math.min(seconds, 1800) * 1000, tick)
      if (!run) throw new Error(`There is no run ${id}.`)
      return resultSaid(q, run)
    } finally {
      release()
    }
  }

  if (name === 'queue_cancel' && id && leases().get(id)) {
    const refused = leases().release(id, { key: typeof args.key === 'string' ? args.key : null, token })
    if (refused) throw new Error(refused)
    return `Released ${id}: its dev server is stopped.`
  }

  if (name === 'queue_lease') return leaseCall(args, query, token)

  if (name === 'queue_cancel') {
    if (!id) throw new Error('queue_cancel takes id.')
    const refused = q.cancel(id, { key: typeof args.key === 'string' ? args.key : null, token })
    if (refused) throw new Error(refused)
    return `Cancelled ${id}.`
  }

  /* 0.6.0's tool, gone with the Inbox asking about results. A session that still calls it is told so, not refused. */
  if (name === 'queue_seen') return SEEN_GONE


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
    const expect = expectOf(args.expect)
    if (!expect.ok) throw new Error(expect.why)
    const epic = epicOf(named.epic)
    const env = agentEnv()
    /* Is the folder ready? Said now, not after the wait (issue #28). */
    if (args.preflight !== undefined && args.preflight !== null && args.preflight !== '') {
      const pre = argvOf(args.preflight, process.env.SHELL || '/bin/sh')
      if (!pre.ok) throw new Error(`preflight: ${pre.why}`)
      const refused = await preflightRefusal(pre.value, cwd.value, env)
      if (refused) throw new Error(refused)
    }
    const checked = args.checks === false ? { refuse: [], warn: [] } : await checkFolder(cwd.value, env)
    if (checked.refuse.length) throw new Error(['Not queued: it would fail before it did anything.', ...wouldFail(checked.refuse), 'Fix that and ask again, or pass checks: false to queue it anyway.'].join('\n'))
    const origin = place ? originFromPlace(place, cwd.value) : await originFromCwd(cwd.value, epic, ASK.options)
    const run = q.enqueue({
      argv: argv.value,
      cwd: cwd.value,
      env,
      kind: kind.value,
      label: label.value,
      refs: refs.value,
      epic,
      project: project ?? projectOf(cwd.value),
      asker: mcpAsker(place, place ? token : null),
      origin,
      expect: expect.value,
    })
    const view = q.view(run)
    return [
      `Queued ${run.id} (key ${run.key}). ${view.state === 'running' ? 'It started at once.' : (view.waiting ?? '')}`,
      ...wouldFail(checked.warn),
      ...waitSaid(run.id, Boolean(place && token)),
      place ? '' : 'Keep the key: without a place, it is how queue_cancel knows the run is yours.',
      DOOR_PLACE_SAYS.used(named.from, place),
    ].filter(Boolean).join('\n')
  }

  throw new Error(`There is no tool "${name.slice(0, 60)}" here. This door has queue_run, queue_status, queue_wait, queue_cancel and queue_lease.`)
}

/** `queue_lease`: run a dev server in a leased slot, answer its port at once. */
async function leaseCall(args: Record<string, unknown>, query: URLSearchParams, token: string | null): Promise<string> {
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
  const label = labelOf(args.label, argv.value)
  if (!label.ok) throw new Error(label.why)
  const range = rangeOf(args.port_range)
  if (!range) throw new Error('port_range is a port range from 1024 up: "5280-5299".')
  const minutes = typeof args.ttl_minutes === 'number' && Number.isFinite(args.ttl_minutes) && args.ttl_minutes > 0 ? args.ttl_minutes : 30
  const asker = mcpAsker(place, place ? token : null)
  const session = typeof args.session === 'string' && /^[\w.:-]{1,128}$/.test(args.session) ? args.session : null
  const taken = await leases().take({
    argv: argv.value,
    cwd: cwd.value,
    env: agentEnv(),
    label: label.value,
    project: project ?? projectOf(cwd.value),
    range,
    ttlMs: Math.min(minutes * 60_000, TTL_DEFAULT_MS * 8),
    asker: { ...asker, session },
    sessionPid: null,
  })
  if (typeof taken === 'string') throw new Error(taken)
  return [
    `Leased ${taken.id} (key ${taken.key}): the dev server runs on port ${taken.port} — http://localhost:${taken.port} — given as $PORT and in place of {port} in the command.`,
    `It is stopped at ${new Date(taken.until).toLocaleTimeString()} (${Math.round((taken.until - taken.startedAt) / 60_000)} min), or when you release it: queue_cancel with id ${taken.id}${place ? '' : ' and the key'}. Release it when you are done with it.`,
    'Its output: queue_status with this id.',
    DOOR_PLACE_SAYS.used(named.from, place),
  ].filter(Boolean).join('\n')
}

interface Rpc {
  id?: number | string
  method?: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

export async function mcp(rpc: Rpc, query: URLSearchParams, q: Queue = queue(), tick?: (said: string) => void): Promise<Reply> {
  const reply = (result: unknown) => ok({ jsonrpc: '2.0', id: rpc.id ?? null, result })
  const text = (said: string, isError = false) => reply({ content: [{ type: 'text', text: said }], ...(isError ? { isError } : {}) })
  if (rpc.method === 'initialize') {
    return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: ID, version: VERSION }, instructions: MANIFEST.mcp?.about ?? '' })
  }
  if (typeof rpc.method === 'string' && rpc.method.startsWith('notifications/')) return { status: 202, body: null }
  if (rpc.method === 'tools/list') return reply({ tools: tools() })
  if (rpc.method === 'tools/call') {
    try {
      return text(await call(String(rpc.params?.name ?? ''), rpc.params?.arguments ?? {}, query, q, tick))
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
  write: (_project, key, value) => {
    const refused = writeValue(DIR, key, value)
    if (!refused && key.startsWith('guard')) MANIFEST.guards = guardsNow()
    return refused
  },
  ticket: TICKET,
})

/** What the page reads: every run, and the machine as the queue sees it. */
export function overview(q: Queue, leased: Leases = leases()) {
  const capacity = capacityOf(readValues(DIR), cores())
  return {
    ok: true,
    runs: q.list(),
    leases: leased.list(),
    machine: { cores: cores(), load: loadNow(), most: capacity.most, loadAbove: capacity.loadAbove, waitMinutes: capacity.waitMs / 60_000, samples: STRAIN.list(), perKind: capacity.perKind, leasesMost: leasesOf(readValues(DIR)) },
  }
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
    if (body?.op === 'release') {
      const no = leases().release(id, { person: true })
      return no ? bad(no) : ok(overview(q))
    }
    if (body?.op === 'move' && (body.to === 'up' || body.to === 'down' || body.to === 'top')) {
      const no = q.move(id, body.to as Move)
      return no ? bad(no) : ok(overview(q))
    }
    return bad('An act is cancel (id), release (id of a dev-server lease) or move (id, to: up, down or top).')
  }

  if (path.startsWith('/api/')) return bad('Not here.', 404)
  return null
}
