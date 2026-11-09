import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

/**
 * Is the folder ready? Checked when a run is ASKED for, outside any slot, so a fault in the folder is
 * said at once instead of after the whole wait (issue #28). Three parts:
 *
 *  - `preflight`, the asker's own quick command: run at once in the run's folder with the run's
 *    environment, for at most `PREFLIGHT_MS`. If it fails, the run is refused with its output and
 *    never waits.
 *  - Built in, cheap: a mise config file mise does not trust (`mise trust --show`), which makes a
 *    login shell refuse the folder — refused, with the command that fixes it; and a `node_modules`
 *    older than the lockfile beside it, or missing — said as "would fail", and queued anyway: it is a
 *    guess from file times.
 *  - After the run: a run that failed within `FAST_MS` of starting is read for a known environment
 *    signature (`signatureOf`), and its result says what to fix before queueing again.
 *
 * Never logs or keeps the environment.
 */

/** The person's home folder: where mise is installed and whose own mise config is not a folder's. Read only; nothing is kept. */
const HOME = homedir() // kehikot-storage: allow only to find mise and tell the person's own mise config from a folder's; nothing is written

/** The longest the asker's own preflight command may take, in ms. */
export const PREFLIGHT_MS = 60_000
/** The longest `mise trust --show` may take, in ms. */
const MISE_MS = 5_000
/** How much of a failed preflight's output is said, in characters: its end. */
export const PREFLIGHT_SAID = 4_000
/** A run that fails within this long of starting is read for an environment signature, in ms. */
export const FAST_MS = 15_000

export interface Checked {
  /** Sentences that refuse the run: it would fail, certainly, before doing anything. */
  refuse: string[]
  /** Sentences said beside the queued run: it may fail. */
  warn: string[]
}

/** What a command came to: its exit code (null: it did not start or ran out of time) and its output. */
export interface Ran {
  code: number | null
  out: string
  timedOut: boolean
}

/** Run argv in cwd with env, for at most ms; never throws. Its own process group, stopped whole at the limit. */
export function runBriefly(argv: readonly string[], cwd: string, env: Record<string, string>, ms: number): Promise<Ran> {
  return new Promise((done) => {
    let out = ''
    let timedOut = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (error) {
      done({ code: null, out: error instanceof Error ? error.message : String(error), timedOut: false })
      return
    }
    const keep = (chunk: Buffer) => {
      out += chunk.toString('utf8')
      if (out.length > PREFLIGHT_SAID * 4) out = out.slice(-PREFLIGHT_SAID * 2)
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* Gone already. */
      }
    }, ms)
    child.once('error', (error) => {
      clearTimeout(timer)
      done({ code: null, out: `${out}${error.message}`, timedOut })
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      done({ code: timedOut ? null : code, out, timedOut })
    })
  })
}

/** The end of some output, as a person reads it: at most `PREFLIGHT_SAID` characters, whole lines. */
export function endOf(text: string, most = PREFLIGHT_SAID): string {
  const trimmed = text.replace(/\s+$/, '')
  if (trimmed.length <= most) return trimmed
  const cut = trimmed.slice(-most)
  const at = cut.indexOf('\n')
  return `…${at >= 0 ? cut.slice(at) : cut}`
}

/** What the asker's preflight came to, as a refusal, or null when it passed. */
export async function preflightRefusal(argv: readonly string[], cwd: string, env: Record<string, string>, ms = PREFLIGHT_MS): Promise<string | null> {
  const ran = await runBriefly(argv, cwd, env, ms)
  if (ran.code === 0) return null
  const what = ran.timedOut ? `did not finish in ${Math.round(ms / 1000)} s` : ran.code === null ? 'could not be run' : `failed (exit ${ran.code})`
  const out = endOf(ran.out)
  return `Not queued: its preflight check ${what}, so the run would not have done any good. Fix that and ask again.${out ? `\nThe preflight said:\n${out}` : ''}`
}

/* ---- mise ---- */

/** The config files mise reads in one folder. */
const MISE_FILES = ['mise.toml', '.mise.toml', 'mise.local.toml', '.mise.local.toml', join('.mise', 'config.toml'), join('.config', 'mise.toml'), join('.config', 'mise', 'config.toml')]

/** Whether the folder or one above it has a mise config file (not the home folder's own). */
export function hasMiseConfig(cwd: string, home = HOME): boolean {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (dir !== home && MISE_FILES.some((name) => existsSync(join(dir, name)))) return true
    if (dirname(dir) === dir) return false
  }
}

/** Where mise may be: the run's PATH, then where its installers put it. */
export function misePath(env: Record<string, string>, home = HOME): string | null {
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs) {
    const file = join(dir, 'mise')
    try {
      if (statSync(file).isFile()) return file
    } catch {
      /* Not here. */
    }
  }
  return null
}

/** The untrusted lines of `mise trust --show`'s answer ("~/w/mise.toml: untrusted"). */
export function untrustedOf(out: string): string[] {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /:\s*untrusted$/i.test(line))
    .map((line) => line.replace(/:\s*untrusted$/i, ''))
}

/* ---- node_modules ---- */

const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']
/** What each package manager writes into node_modules when it installs: the newest says when it last did. */
const INSTALL_MARKS = ['.package-lock.json', '.yarn-integrity', '.yarn-state.yml', '.modules.yaml', '.bun-tag']

const mtimeOf = (file: string): number | null => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}

/** A sentence when the folder's node_modules is missing or older than its lockfile; null when it looks fine or this is no JS project. */
export function nodeModulesSaid(cwd: string): string | null {
  if (!existsSync(join(cwd, 'package.json'))) return null
  const locks = LOCKFILES.map((name) => ({ name, at: mtimeOf(join(cwd, name)) })).filter((one): one is { name: string; at: number } => one.at !== null)
  if (!locks.length) return null
  const lock = locks.reduce((a, b) => (b.at > a.at ? b : a))
  const modules = join(cwd, 'node_modules')
  const installed = [mtimeOf(modules), ...INSTALL_MARKS.map((name) => mtimeOf(join(modules, name)))].filter((one): one is number => one !== null)
  if (!installed.length) return `there is no node_modules in ${cwd}: install its dependencies first, unless the command does.`
  /* A second of slack: a checkout and an install in the same second are not "older". */
  if (Math.max(...installed) + 1000 < lock.at) return `node_modules in ${cwd} is older than ${lock.name}: its dependencies may be stale. Install them again, unless the command does.`
  return null
}

/** The built-in checks for one folder. Cheap: file times, and mise only when a mise config file is there. */
export async function checkFolder(cwd: string, env: Record<string, string>, options: { home?: string; mise?: string | null } = {}): Promise<Checked> {
  const out: Checked = { refuse: [], warn: [] }
  const home = options.home ?? HOME
  if (hasMiseConfig(cwd, home)) {
    const mise = options.mise === undefined ? misePath(env, home) : options.mise
    if (mise) {
      const ran = await runBriefly([mise, 'trust', '--show'], cwd, env, MISE_MS)
      const untrusted = untrustedOf(ran.out)
      if (untrusted.length) out.refuse.push(`mise does not trust ${untrusted.join(', ')}, so a login shell in ${cwd} stops before the command runs. Run \`mise trust\` in that folder (if you trust it), then ask again.`)
    }
  }
  const modules = nodeModulesSaid(cwd)
  if (modules) out.warn.push(modules)
  return out
}

/** What `checkFolder` found, as the lines an asker reads: "would fail: …". */
export const wouldFail = (lines: readonly string[]): string[] => lines.map((line) => `Would fail: ${line}`)

/* ---- after a fast failure ---- */

const SIGNATURES: Array<[RegExp, string]> = [
  [/mise[^\n]*(not trusted|untrusted)|(not trusted|untrusted)[^\n]*mise/i, 'mise does not trust a config file in this folder. Run `mise trust` there (if you trust it), then queue again.'],
  [/Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND|Module not found|ModuleNotFoundError|No module named/, 'a module was not found: install this folder\'s dependencies (or install them again), then queue again.'],
  [/command not found|: not found\b|No such file or directory \(os error 2\)|ENOENT/, 'a program it runs was not found in the run\'s environment: check the command and the PATH, then queue again.'],
]

/** The environment fault a fast failure's output shows, as a sentence, or null. */
export function signatureOf(output: string): string | null {
  for (const [pattern, said] of SIGNATURES) if (pattern.test(output)) return said
  return null
}
