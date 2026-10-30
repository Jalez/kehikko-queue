#!/usr/bin/env bun
/**
 * kehikot-queue — put a heavy run in this computer's Test runs queue, wait for it, and exit with
 * its exit code. For a shell, a script and a git hook:
 *
 *   kehikot-queue run [--kind push|verify|review|other] [--label TEXT] [--ref REF]… [--epic SLUG]
 *                     [--place TOKEN] [--keep-env NAME]… [--from TEXT] -- COMMAND [ARG…]
 *   kehikot-queue status
 *
 * It asks Test runs to run COMMAND in this folder with this environment (less anything that looks
 * like a secret, unless named with --keep-env), prints where it is in the queue while it waits,
 * prints the command's output as it runs, and exits with the command's own exit code. Ctrl-C while
 * waiting cancels the run.
 *
 * When Test runs is not running, or will not take the run, the command runs here, now, outside the
 * queue, and this says so: a hook never breaks because the queue is away.
 *
 * Finds Test runs at the address its registration names (Kehikot's module registry), or
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
  argv: string[]
}

export function parse(args: string[], env: Env = process.env): Parsed | string {
  const out: Parsed = { kind: 'other', label: null, refs: [], epic: null, place: env.KEHIKOT_PLACE || null, keep: [], from: null, argv: [] }
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
    else return `I do not know ${arg}. Put the command after --.`
  }
  if (!out.argv.length) return 'Put the command to run after --: kehikot-queue run --kind push --label "pre-push" -- bun test'
  if (!['push', 'verify', 'review', 'other'].includes(out.kind)) return '--kind is push, verify, review or other.'
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
}

/** What the exit code of a run that ended is, for the shell. */
export function exitFor(run: RunView): number {
  if (run.state === 'passed') return 0
  if (run.state === 'cancelled') return 130
  return run.exit !== null && run.exit !== 0 ? run.exit : 1
}

export async function queued(parsed: Parsed, env: Env = process.env, cwd = process.cwd()): Promise<number> {
  const { url, token } = where(env)
  if (!url) return direct(parsed.argv, 'Test runs is not registered on this computer.')
  if (!token) return direct(parsed.argv, 'Test runs has not run on this computer yet (no token).')
  if (!(await healthy(url))) return direct(parsed.argv, `Test runs is not running (nothing answered at ${url}).`)
  const headers = { 'content-type': 'application/json', [TOKEN_HEADER]: token }

  let answer: { ok?: boolean; id?: string; key?: string; error?: string; dropped?: string[] }
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
      }),
    })
    answer = (await response.json()) as typeof answer
  } catch (error) {
    return direct(parsed.argv, `Test runs did not take the run (${error instanceof Error ? error.message : String(error)}).`)
  }
  if (!answer.ok || !answer.id || !answer.key) return direct(parsed.argv, `Test runs did not take the run: ${answer.error ?? 'no reason given'}.`)
  const { id, key } = answer
  if (answer.dropped?.length) SAY(`left out of its environment as secret-looking: ${answer.dropped.join(', ')} (pass --keep-env NAME to keep one).`)

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

  let from = 0
  let said = ''
  let lostSince: number | null = null
  for (;;) {
    try {
      const response = await fetch(`${url}/api/queue/follow?id=${encodeURIComponent(id)}&from=${from}`, { headers: { [TOKEN_HEADER]: token } })
      if (response.status === 404) return direct(parsed.argv, 'Test runs lost the run.')
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
            if (run.state === 'cancelled' && run.why && /restarted before/.test(run.why)) return direct(parsed.argv, run.why)
            if (run.state === 'failed' && run.exit === null && run.why && /could not be started|environment was lost/.test(run.why)) return direct(parsed.argv, `Test runs could not start it (${run.why}).`)
            SAY(`${id} ${run.state}${run.exit !== null ? ` (exit ${run.exit})` : ''}${run.why ? `: ${run.why}` : '.'}`)
            return exitFor(run)
          }
        }
      }
    } catch {
      /* The module went away mid-wait (an update restarts it): a running run carries on in its own group. */
    }
    lostSince ??= Date.now()
    if (Date.now() - lostSince > 120_000) {
      SAY(`Test runs has not answered for two minutes; ${id} may still be running there.`)
      return 75
    }
    await new Promise((done) => setTimeout(done, 2000))
  }
}

async function status(env: Env = process.env): Promise<number> {
  const { url } = where(env)
  if (!url || !(await healthy(url))) {
    SAY('Test runs is not running.')
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
  } else if (verb === 'status') {
    process.exit(await status())
  } else {
    process.stderr.write('usage: kehikot-queue run [--kind push|verify|review|other] [--label TEXT] [--ref REF] [--epic SLUG] [--place TOKEN] [--keep-env NAME] [--from TEXT] -- COMMAND [ARG…]\n       kehikot-queue status\n')
    process.exit(2)
  }
}
