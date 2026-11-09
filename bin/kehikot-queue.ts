#!/usr/bin/env bun
/**
 * kehikot-queue — put heavy work (tests, a build, any other heavy command) in this computer's
 * Queue, wait for it, and exit with its exit code. For a shell, a script and a git hook:
 *
 *   kehikot-queue run [--kind verify|build|task|push|review] [--label TEXT] [--ref REF]… [--epic SLUG]
 *                     [--place TOKEN] [--keep-env NAME]… [--from TEXT] [--expect fail]
 *                     [--preflight 'SHELL LINE'] [--no-checks] -- COMMAND [ARG…]
 *   kehikot-queue wait ID
 *   kehikot-queue status
 *
 * --kind: verify for tests (the default), build for a build, task for any other heavy command.
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
 * Finds Queue at the address its registration names (Kehikot's module registry), or
 * KEHIKOT_QUEUE_URL. Gets in with the token in the queue's own folder, which only this user can
 * read. Only node's built-in modules here, so this one file can be linked onto PATH as it is.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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
  let token: string | null = null
  try {
    token = readFileSync(join(queueDir(env, platform), 'token'), 'utf8').trim() || null
  } catch {
    /* No token: the queue never ran here. */
  }
  if (env.KEHIKOT_QUEUE_URL) return { url: env.KEHIKOT_QUEUE_URL.replace(/\/+$/, ''), token }
  const registry = env.KEHIKOT_MODULES_DIR || join(machineDir(env, platform), 'modules')
  const file = join(registry, `${ID}.json`)
  if (!existsSync(file)) return { url: null, token }
  try {
    const url = (JSON.parse(readFileSync(file, 'utf8')) as { url?: unknown }).url
    return { url: typeof url === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url.replace(/\/+$/, '')) ? url.replace(/\/+$/, '') : null, token }
  } catch {
    return { url: null, token }
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
  argv: string[]
}

export function parse(args: string[], env: Env = process.env): Parsed | string {
  const out: Parsed = { kind: 'verify', label: null, refs: [], epic: null, place: env.KEHIKOT_PLACE || null, keep: [], from: null, expect: null, preflight: null, checks: true, argv: [] }
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
  if (!['verify', 'build', 'task', 'push', 'review', 'other'].includes(out.kind)) return '--kind is verify (tests, the default), build, task (any other heavy command), push (a hook somebody waits on) or review.'
  return out
}

/** Run the command here, now, as if the queue were not there, and exit with its code. */
export function direct(argv: string[], why: string): Promise<number> {
  SAY(`${why} Running it here, now, outside the queue.`)
  return new Promise((done) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit' })
    child.on('error', (error) => {
      SAY(`could not run ${argv[0]}: ${error.message}`)
      done(127)
    })
    child.on('exit', (code, signal) => done(code ?? 128 + signalNumber(signal)))
  })
}

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

export async function queued(parsed: Parsed, env: Env = process.env, cwd = process.cwd()): Promise<number> {
  const { url, token } = where(env)
  if (!url) return direct(parsed.argv, 'Queue is not registered on this computer.')
  if (!token) return direct(parsed.argv, 'Queue has not run on this computer yet (no token).')
  if (!(await healthy(url))) return direct(parsed.argv, `Queue is not running (nothing answered at ${url}).`)
  const headers = { 'content-type': 'application/json', [TOKEN_HEADER]: token }

  let answer: { ok?: boolean; id?: string; key?: string; error?: string; dropped?: string[]; warn?: string[]; refused?: boolean }
  try {
    const response = await fetch(`${url}/api/queue/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        argv: parsed.argv,
        cwd,
        env,
        keepEnv: parsed.keep,
        kind: parsed.kind,
        label: parsed.label,
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
    return direct(parsed.argv, `Queue did not take the run (${error instanceof Error ? error.message : String(error)}).`)
  }
  /* The folder is not ready: running it here would fail the same way. Say why, and stop. */
  if (answer.refused) {
    for (const line of (answer.error ?? 'Not queued: the folder is not ready.').split('\n')) SAY(line)
    return 1
  }
  if (!answer.ok || !answer.id || !answer.key) return direct(parsed.argv, `Queue did not take the run: ${answer.error ?? 'no reason given'}.`)
  const { id, key } = answer
  if (answer.dropped?.length) SAY(`left out of its environment as secret-looking: ${answer.dropped.join(', ')} (pass --keep-env NAME to keep one).`)
  for (const line of answer.warn ?? []) SAY(line)

  let gone = false
  const cancel = async () => {
    if (gone) return
    gone = true
    SAY(`cancelling ${id}…`)
    await fetch(`${url}/api/queue/cancel`, { method: 'POST', headers, body: JSON.stringify({ id, key }) }).catch(() => {})
    process.exit(130)
  }
  process.once('SIGINT', () => void cancel())
  process.once('SIGTERM', () => void cancel())

  return follow(url, token, id, { expect: parsed.expect, instead: (why) => direct(parsed.argv, why) })
}

/**
 * Follow one run to its end on `/api/queue/follow`: print where it is while it waits, its output as
 * it runs, and say how it ended; answer the exit code for the shell. `instead` is what to do when
 * the queue, not the command, is the trouble (it lost the run, or never started it): `run` runs the
 * command here; `wait` has nothing to run and says so.
 */
export async function follow(url: string, token: string, id: string, options: { expect: 'fail' | null; instead: ((why: string) => Promise<number>) | null }): Promise<number> {
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
  }
}

/** `wait ID`: follow a run already queued to its end, and exit with its code. Ctrl-C stops waiting, not the run. */
export async function waitOn(id: string, env: Env = process.env): Promise<number> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    SAY('wait takes a run\'s id, as queue_run or kehikot-queue status says it: kehikot-queue wait r1a2b3c.')
    return 2
  }
  const { url, token } = where(env)
  if (!url || !token || !(await healthy(url))) {
    SAY(`Queue is not running here, so ${id} cannot be waited on.`)
    return 69
  }
  process.once('SIGINT', () => {
    SAY(`stopped waiting; ${id} goes on in the queue.`)
    process.exit(130)
  })
  return follow(url, token, id, { expect: null, instead: null })
}

async function status(env: Env = process.env): Promise<number> {
  const { url } = where(env)
  if (!url || !(await healthy(url))) {
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
  } else if (verb === 'wait' && rest.length === 1) {
    process.exit(await waitOn(rest[0]!))
  } else if (verb === 'status') {
    process.exit(await status())
  } else {
    process.stderr.write('usage: kehikot-queue run [--kind verify|build|task|push|review] [--label TEXT] [--ref REF] [--epic SLUG] [--place TOKEN] [--keep-env NAME] [--from TEXT] [--expect fail] [--preflight \'LINE\'] [--no-checks] -- COMMAND [ARG…]\n       kehikot-queue wait ID\n       kehikot-queue status\n')
    process.exit(2)
  }
}
