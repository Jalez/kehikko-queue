/**
 * Commands that WAIT: a run holds one of the queue's slots for as long as it lives, so a command that
 * sleeps or polls inside it blocks everyone else's tests and pushes while it does nothing (issue #48),
 * and one that reads the machine's load second-guesses the queue's own rule about when heavy work may
 * start. This reads a shell line the way the guards do (`simpleCommands`, `unwrap`, a look into
 * `sh -c`) and says, in words, why such a line is not queued. Pure. Only node-free imports: the CLI
 * is linked onto PATH as is.
 *
 * False positives are the cost of a text check, so it names PROGRAMS, never substrings: `vitest --watch`
 * is judged by its flag, a test file called `watch.test.ts` or a script called `watch-files` is not
 * `watch`, and `while read line` (a loop over input) is not a polling loop.
 */
import { simpleCommands, unwrap } from './guard-plan.ts'

export interface Waits {
  /** What it does: a sleep, a polling loop, a read of the load. */
  what: string
  /** The sentence the asker is told. */
  why: string
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const base = (word: string) => word.split('/').pop() ?? ''

/** What every refusal ends with: waiting is not the queue's slot's job. */
export const WAITING_WHY = 'Waiting belongs outside the queue: the queue already waits for a quiet machine before it starts heavy work, and a command that sleeps or polls holds one of its slots doing nothing, so every other session waits behind it. Queue the real work, and let the queue decide when it starts.'
export const LOAD_WHY = 'The queue already waits for a quiet machine before it starts heavy work (its load limit is in Settings › Modules), so a command must not read the load and wait for it itself. Queue the real work, and let the queue decide when it starts.'

const LOAD_FILES = /loadavg/
/** Programs that run until stopped when given their watch flag. */
const WATCHERS = new Set(['tsc', 'vitest', 'jest', 'webpack', 'rollup', 'tsup', 'vue-tsc', 'tsgo', 'bun', 'vite', 'next', 'astro'])

function oneWaits(raw: readonly string[], depth: number): Waits | null {
  const words = unwrap(raw)
  if (!words.length) return null
  const program = base(words[0]!)
  const rest = words.slice(1)
  if (SHELLS.has(program) && depth < 3) {
    const at = rest.findIndex((one) => /^-[a-z]*c$/.test(one))
    const inner = at >= 0 ? rest[at + 1] : undefined
    return inner === undefined ? null : waitsIn(inner, depth + 1)
  }
  if (program === 'sleep' || program === 'usleep' || program === 'sleep.exe') return { what: 'it sleeps', why: WAITING_WHY }
  if (program === 'watch') return { what: 'it runs watch, which repeats until stopped', why: WAITING_WHY }
  if (program === 'until') return { what: 'it loops until a condition holds', why: WAITING_WHY }
  if (program === 'while') {
    /* `while read line; do …` takes its input to its end; any other while is waiting for a condition. */
    const condition = rest[0] ?? ''
    if (condition === 'read' || /^IFS=/.test(condition) || condition === 'getopts' || condition === 'shift') return null
    return { what: 'it loops while a condition holds', why: WAITING_WHY }
  }
  if (program === 'uptime') return { what: 'it reads the machine\'s load (uptime)', why: LOAD_WHY }
  if (program === 'sysctl' && rest.some((one) => LOAD_FILES.test(one))) return { what: 'it reads the machine\'s load (sysctl)', why: LOAD_WHY }
  if (rest.some((one) => LOAD_FILES.test(one)) && ['cat', 'head', 'tail', 'awk', 'cut', 'read', 'less', 'more'].includes(program)) return { what: 'it reads the machine\'s load (loadavg)', why: LOAD_WHY }
  if (WATCHERS.has(program) && rest.some((one) => one === '--watch' || one === '-w' || one === '--watchAll' || one === '--watch=true' || one === '--hot') && !(program === 'bun' && rest.some((one) => one === 'run' || one === 'x'))) {
    return { what: `it runs ${program} in watch mode, which never ends`, why: 'A watcher never ends, so it would hold a slot of the queue for as long as it lives. Run it once, without its watch flag.' }
  }
  return null
}

/** Whether a shell line waits (sleeps, polls, watches, reads the load), looking into `sh -c '…'`; null when it does not. */
export function waitsIn(line: string, depth = 0): Waits | null {
  /* A command substitution in backticks is a command of its own, as `$( … )` is (the splitter reads that already). */
  for (const words of simpleCommands(line.replaceAll('`', ';'))) {
    const found = oneWaits(words, depth)
    if (found) return found
  }
  return null
}

/** The refusal an asker reads, for an argv: a shell line is read as it is; a program with its arguments as the one command it is. */
export function refusalFor(argv: readonly string[]): string | null {
  if (!argv.length) return null
  const found = argv.length === 3 && SHELLS.has(base(argv[0]!)) && argv[1] === '-c' ? waitsIn(argv[2]!) : oneWaits(argv, 0)
  return found ? `Not queued: this command waits (${found.what}). ${found.why}` : null
}
