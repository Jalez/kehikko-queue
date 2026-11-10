#!/usr/bin/env bun
/**
 * kehikot-queue — put heavy work (tests, a build, any other heavy command) in this computer's
 * Queue, wait for it, and exit with its exit code. For a shell, a script and a git hook:
 *
 *   kehikot-queue run [--kind verify|typecheck|e2e|build|task|push|review] [--label TEXT] [--ref REF]… [--epic SLUG]
 *                     [--place TOKEN] [--keep-env NAME]… [--from TEXT] [--expect fail]
 *                     [--session ID] [--agent NAME] [--detach]
 *                     [--preflight 'SHELL LINE'] [--no-checks] -- COMMAND [ARG…]
 *   kehikot-queue lease dev [--port-range FROM-TO] [--ttl MINUTES] [--label TEXT] [--session ID] [--agent NAME] -- COMMAND [ARG…]
 *   kehikot-queue wait ID
 *   kehikot-queue status
 *
 * --kind: verify for tests (the default; unit says the same), typecheck for tsc, e2e for browser
 * tests (playwright says the same), build for a build, task for any other heavy command. Each has
 * its own limit of how many run at once on this computer (Settings › Modules).
 *
 * Safe as a transparent stand-in for the command itself (what a shell guard rewrites a heavy
 * command to): it reads no stdin, says its own lines on stderr only, puts the command's output on
 * stdout, and exits with the command's exit code. Without --label it labels the run from the
 * command and the folder. The asking session is --session, else KEHIKOT_SESSION_ID, else the
 * agent CLI's own session variable. Inside a queued run (KEHIKOT_QUEUE_RUN) it runs the command at
 * once: a run never waits behind itself.
 *
 * --guard: what a module guard rewrote an agent's shell command to (`run --guard -- sh -c LINE`,
 * `lease dev --guard -- sh -c LINE`). It decides here whether LINE is heavy work in THIS project
 * (bin/guard-plan.ts, from its package.json): heavy is queued as its kind; light (one test file, a
 * script that is not heavy, --version) runs at once, saying nothing, as if no guard were there. So
 * does a line with KEHIKOT_DIRECT=1.
 *
 * --detach (or KEHIKOT_DETACH=1 in its environment): queue the run and return at once, for a shell
 * tool that cannot wait in the background. It prints one line on stdout — the run's id, where it is
 * in line, and how to read its output — and exits 0. The run then goes on under Queue alone (no child
 * of this shell, and nothing cancels it when this command ends), and when it ends Queue tells the
 * asking session in one line (`messages.notify`), by the place token in --place or KEHIKOT_PLACE. An
 * agent module whose shell tool blocks until a command exits puts `KEHIKOT_DETACH=1 KEHIKOT_PLACE=…`
 * in front of a guard's rewrite. Light work under --guard still runs at once, as above.
 *
 * `lease dev` runs a dev server in one of a few leased slots (Settings › Modules, "Dev servers at
 * once"), on a free port of --port-range (default 5280-5299), given as $PORT and in place of {port}
 * in the command. Queue starts it in a process group of its own and stops that group when this
 * command ends (Ctrl-C, the shell closing it), when --ttl runs out (default 60 minutes), or when
 * the agent session that asked ends. It streams the server's output meanwhile.
 *
 * It asks Queue to run COMMAND in this folder with this environment (less anything that looks
 * like a secret, unless named with --keep-env), prints where it is in the queue while it waits,
 * prints the command's output as it runs, and exits with the command's own exit code. Ctrl-C while
 * waiting cancels the run. `--expect fail` says the run is meant to fail (a red test written before
 * the fix): its failure is then said "as expected", and a pass "but it was expected to fail". The
 * exit code is still the command's own.
 *
 * When Queue is not running, or will not take the run, the command runs here, now, outside the
 * queue, and this says so: a hook never breaks because the queue is away. A run refused because
 * its folder is not ready — `--preflight` (a quick shell line run first, at once) failed, or a
 * built-in check says it would fail (an untrusted mise config; `--no-checks` skips them) — is not
 * run anywhere: this says why and exits 1.
 *
 * `wait ID` waits on a run already queued (by `queue_run`, say) as long as it takes, prints its
 * output, and exits with its exit code like `run` does. Ctrl-C stops waiting; the run goes on. Run
 * it as a background command and whoever started it is told when it exits.
 *
 * Finds Queue at the address its registration names (Kehikot's module registry), read again at
 * every look so a Queue that moved to another port is followed, else at the host's stable address
 * for it (`<host>/m/kehikot.queue`), or only at KEHIKOT_QUEUE_URL when that is set. Gets in with
 * the token in the queue's own folder, which only this user can read. Only node's built-in modules
 * here, so this one file can be linked onto PATH as it is.
 *
 * When Kehikot restarts, Queue is away for a while. A Queue that is registered here and has run
 * before is waited for, up to KEHIKOT_QUEUE_PATIENCE seconds (20), before anything runs outside
 * it: a guard's rewrite is then queued as soon as Queue answers again, not run unguarded. Only
 * when it never answers does the command run here, and this says so. A run being followed when
 * Queue goes away is found again wherever Queue comes back.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { escaped, planOf } from './guard-plan.ts'

const ID = 'kehikot.queue'
const TOKEN_HEADER = 'x-kehikot-queue-token'
const SAY = (line: string) => process.stderr.write(`kehikot-queue: ${line}\n`)

type Env = Record<string, string | undefined>

/** The machine's Kehikot folder, as the host spells it: `Kehikot` on macOS, lowercase `kehikot` elsewhere. */
export function machineDir(env: Env = process.env, platform: string = process.platform): string {
  const home = homedir() // kehikot-storage: allow the CLI reads the queue's machine folder and Kehikot's module registry
  return platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Kehikot') : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'kehikot')
}

/**
 * The queue's own folder, for the server (`queue/machine.ts`) and this CLI alike. Off macOS, 0.4.0
 * and earlier spelled the machine folder `Kehikot`; a queue folder kept there stays the queue's
 * until a lowercase one exists, so its runs, settings and token carry on.
 */
export function queueDir(env: Env = process.env, platform: string = process.platform): string {
  if (env.KEHIKOT_QUEUE_DIR) return env.KEHIKOT_QUEUE_DIR
  const dir = join(machineDir(env, platform), 'queue')
  if (platform === 'darwin' || existsSync(dir)) return dir
  const before = join(dirname(machineDir(env, platform)), 'Kehikot', 'queue')
  return existsSync(before) ? before : dir
}

export function where(env: Env = process.env, platform: string = process.platform): { url: string | null; token: string | null } {
  const found = addresses(env, platform)
  return { url: found.registered, token: found.token }
}

/** Whether a string is an address this CLI asks: http to this machine, no path, no trailing slash. */
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/

/**
 * The host's stable addresses for Queue (`<host>/m/kehikot.queue`, the host proxying to wherever
 * Queue bound): one per loopback http origin in KEHIKOT_ORIGINS or KEHIKOT_ORIGIN, else the app's
 * own (`http://127.0.0.1:4170`) — but only for the machine's own registry: with KEHIKOT_MODULES_DIR
 * moved (a test, another setup) no host is assumed.
 */
export function hostAddresses(env: Env = process.env): string[] {
  const said = [...(env.KEHIKOT_ORIGINS ?? '').split(/\s+/), ...(env.KEHIKOT_ORIGIN ?? '').split(/\s+/)].map((one) => one.replace(/\/+$/, '')).filter((one) => LOOPBACK.test(one))
  const hosts = said.length ? said : env.KEHIKOT_MODULES_DIR ? [] : ['http://127.0.0.1:4170']
  return [...new Set(hosts.map((one) => one.replace('//localhost', '//127.0.0.1')))].slice(0, 4).map((one) => `${one}/m/${ID}`)
}

/**
 * Every address Queue may answer at, in the order asked: KEHIKOT_QUEUE_URL alone when it is set;
 * else what its registration names now, then the host's stable addresses. `known`: Queue is
 * registered here (or named), so it is worth waiting for while Kehikot restarts.
 */
export function addresses(env: Env = process.env, platform: string = process.platform): { urls: string[]; registered: string | null; known: boolean; token: string | null } {
  let token: string | null = null
  try {
    token = readFileSync(join(queueDir(env, platform), 'token'), 'utf8').trim() || null
  } catch {
    /* No token: the queue never ran here. */
  }
  if (env.KEHIKOT_QUEUE_URL) {
    const url = env.KEHIKOT_QUEUE_URL.replace(/\/+$/, '')
    return { urls: [url], registered: url, known: true, token }
  }
  const registry = env.KEHIKOT_MODULES_DIR || join(machineDir(env, platform), 'modules')
  const file = join(registry, `${ID}.json`)
  if (!existsSync(file)) return { urls: [], registered: null, known: false, token }
  let registered: string | null = null
  try {
    const url = (JSON.parse(readFileSync(file, 'utf8')) as { url?: unknown }).url
    const bare = typeof url === 'string' ? url.replace(/\/+$/, '') : ''
    registered = LOOPBACK.test(bare) ? bare : null
  } catch {
    /* Being rewritten, or not JSON: the host's address still may answer. */
  }
  return { urls: [...new Set([...(registered ? [registered] : []), ...hostAddresses(env)])], registered, known: true, token }
}

/** How long a registered Queue that does not answer is waited for, in ms: KEHIKOT_QUEUE_PATIENCE seconds, else 20. */
export function patienceOf(env: Env = process.env): number {
  const said = Number(env.KEHIKOT_QUEUE_PATIENCE)
  return env.KEHIKOT_QUEUE_PATIENCE !== undefined && env.KEHIKOT_QUEUE_PATIENCE !== '' && Number.isFinite(said) && said >= 0 ? Math.min(said, 600) * 1000 : 20_000
}

/** How often a Queue that is away is looked for again while it is waited for. */
const LOOK_EVERY_MS = 1000

/**
 * Where Queue answers now: the first of its addresses (read again at every look) whose `/healthz`
 * says it is Queue. Looks again every second for up to `patience` ms while none does — Kehikot
 * restarting — saying once that it waits. Null when none answered in that time.
 */
export async function locate(env: Env = process.env, patience = 0, say: ((line: string) => void) | null = SAY): Promise<string | null> {
  const until = Date.now() + patience
  let told = false
  for (;;) {
    const { urls } = addresses(env)
    const asked = await Promise.all(urls.map(async (url) => ((await healthy(url)) ? url : null)))
    const found = asked.find((one) => one !== null)
    if (found) {
      if (told) say?.(`Queue answers again at ${found}.`)
      return found
    }
    if (Date.now() >= until) return null
    if (!told && say) {
      told = true
      say(`Queue did not answer${urls.length ? ` (asked ${urls.join(', ')})` : ''}. Kehikot may be restarting: waiting up to ${Math.round(patience / 1000)} s for it before running anything outside the queue.`)
    }
    await new Promise((done) => setTimeout(done, Math.min(LOOK_EVERY_MS, Math.max(0, until - Date.now()))))
  }
}

export interface Parsed {
  kind: string
  label: string | null
  refs: string[]
  epic: string | null
  place: string | null
  keep: string[]
  from: string | null
  /** 'fail': the run is meant to fail. */
  expect: 'fail' | null
  /** A quick check run at once, before the run waits, as argv; null for none. */
  preflight: string[] | null
  /** False: skip the built-in checks of the folder. */
  checks: boolean
  /** The agent session that asks, when known. */
  session: string | null
  /** Which agent asks, in its own words. */
  agent: string | null
  /** Rewritten to this by a guard: decide here whether the command is heavy in this project (`guard-plan.ts`). */
  guard: boolean
  /** Queue it and return at once; the asking session is told when it ends. */
  detach: boolean
  argv: string[]
}

/** The asking agent session's id: as passed, else as its agent CLI says it in the environment. */
export function sessionOf(env: Env): string | null {
  const said = env.KEHIKOT_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || ''
  return /^[\w.:-]{1,128}$/.test(said) ? said : null
}

/** Whether a variable says yes: set, not empty, not `0` (as KEHIKOT_DIRECT is read). */
const yes = (value: string | undefined): boolean => value !== undefined && value !== '' && value !== '0'

/** The variables that steer the CLI itself, kept out of the run's environment. */
export const OWN_ENV = ['KEHIKOT_DETACH', 'KEHIKOT_PLACE'] as const

/** Which agent asks, in a few words: as passed, else what its environment says. */
export function agentOf(env: Env): string | null {
  if (env.KEHIKOT_AGENT) return env.KEHIKOT_AGENT.slice(0, 60)
  if (env.CLAUDECODE) return 'Claude Code'
  if (env.CODEX_SANDBOX || env.CODEX_SESSION_ID) return 'Codex'
  return null
}

/** How the run is labelled when nobody said: the folder, and the command's own words, short. */
export function autoLabel(argv: readonly string[], cwd: string): string {
  const shell = /(^|\/)(sh|bash|zsh|dash)$/.test(argv[0] ?? '')
  const at = shell ? argv.findIndex((one) => /^-l?c$/.test(one)) : -1
  let words = at >= 0 && argv[at + 1] !== undefined ? argv[at + 1]! : argv.join(' ')
  /* Leading `env`, `VAR=value` and `cd <dir> &&` say nothing about what runs. */
  words = words.replace(/^\s*cd\s+\S+\s*&&\s*/, '').replace(/^\s*(env\s+)?(\w+=\S*\s+)+/, '').replace(/\s+/g, ' ').trim()
  const folder = basename(cwd)
  const label = folder ? `${folder}: ${words}` : words
  return label.length > 100 ? `${label.slice(0, 99)}…` : label
}

/* The queue's other words for kinds (queue/kinds.ts), spelled here because this file imports only node's own. */
const KIND_ALIASES: Record<string, string> = { unit: 'verify', test: 'verify', tests: 'verify', playwright: 'e2e', tsc: 'typecheck' }

export function parse(args: string[], env: Env = process.env): Parsed | string {
  const out: Parsed = { kind: 'verify', label: null, refs: [], epic: null, place: env.KEHIKOT_PLACE || null, keep: [], from: null, expect: null, preflight: null, checks: true, session: sessionOf(env), agent: agentOf(env), guard: false, detach: yes(env.KEHIKOT_DETACH), argv: [] }
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    if (arg === '--') {
      out.argv = args.slice(at + 1)
      break
    }
    const value = () => args[++at]
    if (arg === '--kind') out.kind = value() ?? ''
    else if (arg === '--label') out.label = value() ?? null
    else if (arg === '--ref') out.refs.push(value() ?? '')
    else if (arg === '--epic') out.epic = value() ?? null
    else if (arg === '--place') out.place = value() ?? null
    else if (arg === '--keep-env') out.keep.push(value() ?? '')
    else if (arg === '--from') out.from = value() ?? null
    else if (arg === '--no-checks') out.checks = false
    else if (arg === '--session') out.session = value()?.slice(0, 128) || null
    else if (arg === '--agent') out.agent = value()?.slice(0, 60) || null
    else if (arg === '--guard') out.guard = true
    else if (arg === '--detach') out.detach = true
    else if (arg === '--preflight') {
      const line = value()?.trim()
      if (!line) return '--preflight takes one shell line, quoted: --preflight \'bun install --frozen-lockfile --dry-run\'.'
      out.preflight = ['/bin/sh', '-c', line]
    }
    else if (arg === '--expect') {
      const said = value()
      if (said !== 'fail') return '--expect takes fail: --expect fail, for a run meant to fail (a red test written before the fix).'
      out.expect = 'fail'
    } else return `I do not know ${arg}. Put the command after --.`
  }
  if (!out.argv.length) return 'Put the command to run after --: kehikot-queue run --kind push --label "pre-push" -- bun test'
  /* The queue's kinds (queue/kinds.ts), spelled here because this file imports only node's own. */
  out.kind = KIND_ALIASES[out.kind] ?? out.kind
  if (!['verify', 'build', 'task', 'push', 'review', 'other', 'typecheck', 'e2e'].includes(out.kind)) return '--kind is verify (tests, the default; or unit), typecheck, e2e (or playwright), build, task (any other heavy command), push (a hook somebody waits on) or review.'
  return out
}

/** Run the command here, now, as if the queue were not there, and exit with its code. */
export function direct(argv: string[], why: string, inside = false): Promise<number> {
  SAY(inside ? `${why} Running it here, now.` : `${why} Running it here, now, outside the queue.`)
  return new Promise((done) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit' })
    child.on('error', (error) => {
      SAY(`could not run ${argv[0]}: ${error.message}`)
      done(127)
    })
    child.on('exit', (code, signal) => done(code ?? 128 + signalNumber(signal)))
  })
}

/** What stops a waiting CLI: Ctrl-C at a terminal, a tool's timeout or a closed shell without one. */
const STOPS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }
const signalNumber = (signal: string | null) => (signal && SIGNALS[signal]) || 1

async function healthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) })
    const body = (await response.json()) as { id?: unknown }
    return response.ok && body.id === ID
  } catch {
    return false
  }
}

interface RunView {
  id: string
  state: string
  exit: number | null
  why: string | null
  waiting: string | null
  position: number | null
  expect?: 'fail' | null
}

/** What the exit code of a run that ended is, for the shell. */
export function exitFor(run: RunView): number {
  if (run.state === 'passed') return 0
  if (run.state === 'cancelled') return 130
  return run.exit !== null && run.exit !== 0 ? run.exit : 1
}

/** The line a guard's rewrite runs (`sh -c LINE`), or null when the command is not one. */
export const guardedLine = (argv: readonly string[]): string | null => (argv.length === 3 && /(^|\/)(sh|bash|zsh)$/.test(argv[0]!) && argv[1] === '-c' ? argv[2]! : null)

/** Run the command here, now, saying nothing: what a guard's rewrite does with light work, as if no guard were there. */
export function quietly(argv: string[]): Promise<number> {
  return new Promise((done) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit' })
    child.on('error', () => done(127))
    child.on('exit', (code, signal) => done(code ?? 128 + signalNumber(signal)))
  })
}

export async function queued(parsed: Parsed, env: Env = process.env, cwd = process.cwd()): Promise<number> {
  if (parsed.guard) {
    const line = guardedLine(parsed.argv)
    if (line === null || escaped(line, env)) return quietly(parsed.argv)
    const plan = planOf(line, cwd)
    if ('direct' in plan) return quietly(parsed.argv)
    parsed.kind = plan.queue
    parsed.from ??= `${parsed.agent ? `${parsed.agent}'s` : 'an agent\'s'} shell, through Queue's guard`
  }
  if (env.KEHIKOT_QUEUE_RUN) return direct(parsed.argv, `This is already inside queued run ${env.KEHIKOT_QUEUE_RUN}, so it does not wait behind it.`, true)
  const { known, token } = addresses(env)
  if (!known) return direct(parsed.argv, 'Queue is not registered on this computer.')
  if (!token) return direct(parsed.argv, 'Queue has not run on this computer yet (no token).')
  const patience = patienceOf(env)
  const url = await locate(env, patience)
  if (!url) return direct(parsed.argv, patience ? `Queue is not running (nothing answered for ${Math.round(patience / 1000)} s; if Kehikot is restarting, it is taking longer).` : 'Queue is not running (nothing answered).')
  const headers = { 'content-type': 'application/json', [TOKEN_HEADER]: token }
  /* A stop asked for while the run is being queued is held, and acted on as soon as its id is known. */
  let stopAsked = false
  const early = () => {
    stopAsked = true
  }
  for (const signal of STOPS) process.once(signal, early)

  let answer: { ok?: boolean; id?: string; key?: string; error?: string; dropped?: string[]; warn?: string[]; refused?: boolean; told?: boolean; run?: { state?: string; position?: number | null } }
  /* What the CLI itself was steered by is not the run's. */
  const runEnv: Env = Object.fromEntries(Object.entries(env).filter(([name]) => !(OWN_ENV as readonly string[]).includes(name)))
  try {
    const response = await fetch(`${url}/api/queue/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        argv: parsed.argv,
        cwd,
        /* A terminal sees the run's colours, as it would have run here. */
        env: process.stdout.isTTY && !env.NO_COLOR && !env.FORCE_COLOR ? { ...runEnv, FORCE_COLOR: '1' } : runEnv,
        keepEnv: parsed.keep,
        kind: parsed.kind,
        label: parsed.label ?? autoLabel(parsed.argv, cwd),
        session: parsed.session,
        agent: parsed.agent,
        /* A detached run has nobody waiting on it: this command's end must not cancel it. */
        ...(parsed.detach ? {} : { holder: process.pid }),
        refs: parsed.refs,
        epic: parsed.epic,
        place: parsed.place,
        from: parsed.from ?? (env.CLAUDECODE ? 'a Claude Code session\'s shell' : 'a shell'),
        ...(parsed.expect ? { expect: parsed.expect } : {}),
        ...(parsed.preflight ? { preflight: parsed.preflight } : {}),
        ...(parsed.checks ? {} : { checks: false }),
      }),
    })
    answer = (await response.json()) as typeof answer
  } catch (error) {
    return stopAsked ? 130 : direct(parsed.argv, `Queue did not take the run (${error instanceof Error ? error.message : String(error)}).`)
  }
  if (stopAsked && !(answer.ok && answer.id && answer.key)) return 130
  /* The folder is not ready: running it here would fail the same way. Say why, and stop. */
  if (answer.refused) {
    for (const line of (answer.error ?? 'Not queued: the folder is not ready.').split('\n')) SAY(line)
    return 1
  }
  if (!answer.ok || !answer.id || !answer.key) return direct(parsed.argv, `Queue did not take the run: ${answer.error ?? 'no reason given'}.`)
  const { id, key } = answer
  if (answer.dropped?.length) SAY(`left out of its environment as secret-looking: ${answer.dropped.join(', ')} (pass --keep-env NAME to keep one).`)
  for (const line of answer.warn ?? []) SAY(line)

  if (parsed.detach) {
    for (const signal of STOPS) process.off(signal, early)
    process.stdout.write(`${detachedLine(id, answer.run ?? null, answer.told === true)}\n`)
    return 0
  }

  let gone = false
  const cancel = async () => {
    if (gone) return
    gone = true
    SAY(`cancelling ${id}…`)
    const at = (await locate(env, 0, null)) ?? url
    await fetch(`${at}/api/queue/cancel`, { method: 'POST', headers, body: JSON.stringify({ id, key }) }).catch(() => {})
    process.exit(130)
  }
  for (const signal of STOPS) {
    process.off(signal, early)
    process.once(signal, () => void cancel())
  }
  if (stopAsked) await cancel()

  return follow(url, token, id, { expect: parsed.expect, instead: (why) => direct(parsed.argv, why), find: () => locate(env, 0, null) })
}

/** The CLI as a shell runs it (the wrapper beside this file), quoted: its path has spaces on macOS. */
const SELF = ((path: string) => (/^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`))(join(import.meta.dirname, 'kehikot-queue'))

/**
 * The one line `--detach` prints: the run's id, where it is, who will be told, and how to read its
 * output. `told`: the queue holds a place to tell the asking session at.
 */
export function detachedLine(id: string, run: { state?: string; position?: number | null } | null, told: boolean): string {
  const where = run?.state === 'running' ? 'running now' : typeof run?.position === 'number' ? `#${run.position} in line` : 'waiting its turn'
  const read = `read its output with queue_wait or queue_status id ${id} (or ${SELF} wait ${id})`
  return told
    ? `Queued as ${id} (${where}). You'll be told in this session when it finishes; ${read}.`
    : `Queued as ${id} (${where}). Nothing will tell this session when it finishes (no place to tell was given); ${read}.`
}

/**
 * Follow one run to its end on `/api/queue/follow`: print where it is while it waits, its output as
 * it runs, and say how it ended; answer the exit code for the shell. `instead` is what to do when
 * the queue, not the command, is the trouble (it lost the run, or never started it): `run` runs the
 * command here; `wait` has nothing to run and says so.
 */
export async function follow(start: string, token: string, id: string, options: { expect: 'fail' | null; instead: ((why: string) => Promise<number>) | null; find?: () => Promise<string | null> }): Promise<number> {
  let url = start
  const insteadOr = (why: string, code: number) => (options.instead ? options.instead(why) : (SAY(why), Promise.resolve(code)))
  let from = 0
  let said = ''
  let lostSince: number | null = null
  for (;;) {
    try {
      const response = await fetch(`${url}/api/queue/follow?id=${encodeURIComponent(id)}&from=${from}`, { headers: { [TOKEN_HEADER]: token } })
      if (response.status === 404) return insteadOr(options.instead ? 'Queue lost the run.' : `There is no run ${id} in the queue (it may have been forgotten). kehikot-queue status lists them.`, 2)
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      lostSince = null
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let held = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        held += decoder.decode(value, { stream: true })
        let at: number
        while ((at = held.indexOf('\n')) >= 0) {
          const line = held.slice(0, at)
          held = held.slice(at + 1)
          if (!line.trim()) continue
          const event = JSON.parse(line) as { run?: RunView; out?: string; next?: number; end?: RunView }
          if (event.out !== undefined) {
            process.stdout.write(event.out)
            if (typeof event.next === 'number') from = event.next
          }
          if (event.run) {
            const now = event.run.state === 'queued' ? `queued ${id}: ${event.run.waiting ?? ''}` : event.run.state === 'running' ? `${id} is running.` : ''
            if (now && now !== said) {
              said = now
              SAY(now)
            }
          }
          if (event.end) {
            const run = event.end
            /* The queue's own trouble, not the command's: the run never started. Run it here instead. */
            if (options.instead && run.state === 'cancelled' && run.why && /restarted before/.test(run.why)) return options.instead(run.why)
            if (options.instead && run.state === 'failed' && run.exit === null && run.why && /could not be started|environment was lost/.test(run.why)) return options.instead(`Queue could not start it (${run.why}).`)
            const expect = options.expect ?? run.expect ?? null
            const expected = expect === 'fail' ? (run.state === 'failed' ? ', as expected' : run.state === 'passed' ? ', but it was expected to fail' : '') : ''
            SAY(`${id} ${run.state}${run.exit !== null ? ` (exit ${run.exit})` : ''}${expected}${run.why ? `: ${run.why}` : '.'}`)
            return exitFor(run)
          }
        }
      }
    } catch {
      /* The module went away mid-wait (an update restarts it): a running run carries on in its own group. */
    }
    lostSince ??= Date.now()
    if (Date.now() - lostSince > 120_000) {
      SAY(`Queue has not answered for two minutes; ${id} may still be running there.`)
      return 75
    }
    await new Promise((done) => setTimeout(done, 2000))
    /* Queue may come back on another port (Kehikot restarted): follow it there. */
    url = (await options.find?.().catch(() => null)) ?? url
  }
}

/** `wait ID`: follow a run already queued to its end, and exit with its code. Ctrl-C stops waiting, not the run. */
export async function waitOn(id: string, env: Env = process.env): Promise<number> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    SAY('wait takes a run\'s id, as queue_run or kehikot-queue status says it: kehikot-queue wait r1a2b3c.')
    return 2
  }
  const { known, token } = addresses(env)
  const url = known && token ? await locate(env, patienceOf(env)) : null
  if (!url || !token) {
    SAY(`Queue is not running here, so ${id} cannot be waited on.`)
    return 69
  }
  process.once('SIGINT', () => {
    SAY(`stopped waiting; ${id} goes on in the queue.`)
    process.exit(130)
  })
  return follow(url, token, id, { expect: null, instead: null, find: () => locate(env, 0, null) })
}

/** An agent CLI's own process, by its command's name. */
const AGENT_CLI = /(^|\/)(claude|codex|gemini|opencode|vibe)(\s|$)/

/**
 * The asking agent session's process: as its environment says (KEHIKOT_SESSION_PID, CLAUDE_PID), else
 * the nearest ancestor whose command is an agent CLI. Null when there is none: a person's own shell.
 */
export function sessionPidOf(env: Env = process.env, parentOf: (pid: number) => { ppid: number; command: string } | null = psParent): number | null {
  for (const said of [env.KEHIKOT_SESSION_PID, env.CLAUDE_PID]) {
    const pid = Number(said)
    if (Number.isInteger(pid) && pid > 1) return pid
  }
  let pid = process.ppid
  for (let step = 0; step < 16 && pid > 1; step++) {
    const one = parentOf(pid)
    if (!one) return null
    if (AGENT_CLI.test(one.command)) return pid
    pid = one.ppid
  }
  return null
}

function psParent(pid: number): { ppid: number; command: string } | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim()
    const match = /^(\d+)\s+(.*)$/.exec(out)
    return match ? { ppid: Number(match[1]), command: match[2]! } : null
  } catch {
    return null
  }
}

export interface LeaseParsed {
  guard?: boolean
  range: string | null
  ttl: number | null
  label: string | null
  session: string | null
  agent: string | null
  keep: string[]
  argv: string[]
}

export function parseLease(args: string[], env: Env = process.env): LeaseParsed | string {
  if (args[0] !== 'dev') return 'lease takes what to lease first: kehikot-queue lease dev -- bun run dev'
  const out: LeaseParsed = { range: null, ttl: null, label: null, session: sessionOf(env), agent: agentOf(env), keep: [], argv: [] }
  for (let at = 1; at < args.length; at++) {
    const arg = args[at]!
    if (arg === '--') {
      out.argv = args.slice(at + 1)
      break
    }
    const value = () => args[++at]
    if (arg === '--port-range') out.range = value() ?? null
    else if (arg === '--ttl') {
      const minutes = Number(value())
      if (!Number.isFinite(minutes) || minutes <= 0) return '--ttl is how many minutes the lease lasts: --ttl 60.'
      out.ttl = minutes
    } else if (arg === '--label') out.label = value() ?? null
    else if (arg === '--session') out.session = value()?.slice(0, 128) || null
    else if (arg === '--agent') out.agent = value()?.slice(0, 60) || null
    else if (arg === '--keep-env') out.keep.push(value() ?? '')
    else if (arg === '--guard') out.guard = true
    else return `I do not know ${arg}. Put the command after --.`
  }
  if (!out.argv.length) return 'Put the dev server\'s command after --: kehikot-queue lease dev --port-range 5280-5299 -- bun run dev'
  if (out.range !== null && !/^\d{4,5}(-\d{4,5})?$/.test(out.range)) return '--port-range is FROM-TO: --port-range 5280-5299.'
  return out
}

/** `lease dev`: run a dev server in a leased slot, print its output, and release it when this ends. */
export async function leased(parsed: LeaseParsed, env: Env = process.env, cwd = process.cwd()): Promise<number> {
  if (parsed.guard) {
    const line = guardedLine(parsed.argv)
    /* A question to the tool, or a line that asks to pass every guard, is not a dev server to lease. */
    if (line === null || escaped(line, env) || /(^|\s)(--version|-v|--help|-h)(\s|$)/.test(line)) return quietly(parsed.argv)
  }
  const { known, token } = addresses(env)
  const port = parsed.range ? Number(parsed.range.split('-')[0]) : 5280
  const here = (why: string) => {
    /* No queue: the server runs here, as asked, on the first port of the range. */
    SAY(`${why} Running the dev server here, now, without a lease, on port ${port}.`)
    return new Promise<number>((done) => {
      const argv = parsed.argv.map((word) => word.replaceAll('{port}', String(port)))
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, PORT: String(port) } })
      child.on('error', (error) => {
        SAY(`could not run ${argv[0]}: ${error.message}`)
        done(127)
      })
      child.on('exit', (code, signal) => done(code ?? 128 + signalNumber(signal)))
    })
  }
  if (!known) return here('Queue is not registered on this computer.')
  if (!token) return here('Queue has not run on this computer yet (no token).')
  const patience = patienceOf(env)
  let url = await locate(env, patience)
  if (!url) return here(`Queue is not running (nothing answered${patience ? ` for ${Math.round(patience / 1000)} s` : ''}).`)
  const headers = { 'content-type': 'application/json', [TOKEN_HEADER]: token }
  let answer: { ok?: boolean; id?: string; key?: string; port?: number; until?: number; error?: string }
  try {
    const response = await fetch(`${url}/api/queue/lease`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        argv: parsed.argv,
        cwd,
        env,
        keepEnv: parsed.keep,
        label: parsed.label ?? autoLabel(parsed.argv, cwd),
        range: parsed.range,
        ttlMinutes: parsed.ttl,
        session: parsed.session,
        agent: parsed.agent,
        holder: process.pid,
        sessionPid: sessionPidOf(env),
        place: env.KEHIKOT_PLACE || undefined,
        from: env.CLAUDECODE ? 'a Claude Code session\'s shell' : 'a shell',
      }),
    })
    answer = (await response.json()) as typeof answer
  } catch (error) {
    return here(`Queue did not take the lease (${error instanceof Error ? error.message : String(error)}).`)
  }
  if (refusedLease(answer)) {
    SAY(answer.error ?? 'No dev-server slot is free.')
    return 75
  }
  const { id, key } = answer as { id: string; key: string }
  SAY(`dev server leased on port ${answer.port} (http://localhost:${answer.port}), lease ${id}. It stops when this command ends, at ${new Date(answer.until ?? Date.now()).toLocaleTimeString()}, or when the session that asked ends.`)
  let gone = false
  const release = async (code: number) => {
    if (gone) return
    gone = true
    SAY(`releasing ${id}: stopping the dev server…`)
    const at = (await locate(env, 0, null)) ?? url
    await fetch(`${at}/api/queue/lease/release`, { method: 'POST', headers, body: JSON.stringify({ id, key }) }).catch(() => {})
    process.exit(code)
  }
  process.once('SIGINT', () => void release(130))
  process.once('SIGTERM', () => void release(143))
  process.once('SIGHUP', () => void release(129))

  let from = 0
  let lostSince: number | null = null
  for (;;) {
    try {
      const response = await fetch(`${url}/api/queue/lease/follow?id=${encodeURIComponent(id)}&from=${from}`, { headers: { [TOKEN_HEADER]: token } })
      if (response.status === 404) {
        SAY('Queue lost the lease.')
        return 1
      }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      lostSince = null
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let held = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        held += decoder.decode(value, { stream: true })
        let at: number
        while ((at = held.indexOf('\n')) >= 0) {
          const line = held.slice(0, at)
          held = held.slice(at + 1)
          if (!line.trim()) continue
          const event = JSON.parse(line) as { out?: string; next?: number; end?: { exit: number | null; why: string | null } }
          if (event.out !== undefined) {
            process.stdout.write(event.out)
            if (typeof event.next === 'number') from = event.next
          }
          if (event.end) {
            SAY(`the dev server stopped${event.end.why ? `: ${event.end.why}` : '.'}`)
            gone = true
            return event.end.exit ?? 1
          }
        }
      }
    } catch {
      /* The module went away mid-lease (an update restarts it): the server carries on in its own group. */
    }
    lostSince ??= Date.now()
    if (Date.now() - lostSince > 120_000) {
      SAY(`Queue has not answered for two minutes; the dev server of ${id} may still be running there.`)
      return 75
    }
    await new Promise((done) => setTimeout(done, 2000))
    url = (await locate(env, 0, null).catch(() => null)) ?? url
  }
}

const refusedLease = (answer: { ok?: boolean; id?: string; key?: string }) => !answer.ok || !answer.id || !answer.key

async function status(env: Env = process.env): Promise<number> {
  const url = addresses(env).known ? await locate(env, patienceOf(env)) : null
  if (!url) {
    SAY('Queue is not running.')
    return 1
  }
  const body = (await (await fetch(`${url}/api/runs`)).json()) as { runs: Array<RunView & { label: string; asker: { said: string } }> }
  for (const run of body.runs.slice(0, 30)) {
    process.stdout.write(`${run.id}  ${run.state.padEnd(9)} ${run.label}  — ${run.state === 'queued' ? run.waiting : run.asker.said}\n`)
  }
  if (!body.runs.length) process.stdout.write('Nothing queued, running or finished lately.\n')
  return 0
}

if (import.meta.main) {
  const [verb, ...rest] = process.argv.slice(2)
  if (verb === 'run') {
    const parsed = parse(rest)
    if (typeof parsed === 'string') {
      SAY(parsed)
      process.exit(2)
    }
    process.exit(await queued(parsed))
  } else if (verb === 'lease') {
    const parsed = parseLease(rest)
    if (typeof parsed === 'string') {
      SAY(parsed)
      process.exit(2)
    }
    process.exit(await leased(parsed))
  } else if (verb === 'wait' && rest.length === 1) {
    process.exit(await waitOn(rest[0]!))
  } else if (verb === 'status') {
    process.exit(await status())
  } else {
    process.stderr.write('usage: kehikot-queue run [--kind verify|typecheck|e2e|build|task|push|review] [--label TEXT] [--ref REF] [--epic SLUG] [--place TOKEN] [--keep-env NAME] [--from TEXT] [--expect fail] [--session ID] [--agent NAME] [--detach] [--preflight \'LINE\'] [--no-checks] -- COMMAND [ARG…]\n       kehikot-queue lease dev [--port-range FROM-TO] [--ttl MINUTES] [--label TEXT] [--session ID] [--agent NAME] -- COMMAND [ARG…]\n       kehikot-queue wait ID\n       kehikot-queue status\n')
    process.exit(2)
  }
}
