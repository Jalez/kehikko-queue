/**
 * What a command a guard rewrote to `kehikot-queue run --guard` (or `lease dev --guard`) really is,
 * in THIS project: Queue's guards in the manifest cast a wide net (`queue/guards.ts`), and this decides
 * per command, from the project's own package.json, whether it is heavy (queued, with the kind its
 * limit counts against) or light (run at once, as if no guard were there):
 *
 *  - a typecheck, a test suite, browser tests, a build or an install is heavy;
 *  - a test run of ONE file (`bun test src/a.test.ts`, `vitest run a.test.ts`) is light;
 *  - `bun run <script>` is what the script's own line in package.json is; a script package.json does
 *    not have is judged by its name;
 *  - `--version` and `--help` are light; so is anything else.
 *
 * Pure but for reading package.json files. Only node's own modules: the CLI is linked onto PATH as is.
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export type HeavyKind = 'e2e' | 'build' | 'typecheck' | 'verify' | 'task'
/** The kind a compound command is queued as: the heaviest of its parts. */
const ORDER: readonly HeavyKind[] = ['e2e', 'build', 'typecheck', 'verify', 'task']

export type Plan = { queue: HeavyKind } | { direct: string }

/** The simple commands of a shell line: split on `&&`, `||`, `;`, `|`, `&` and newlines, outside quotes. */
export function simpleCommands(line: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let has = false
  let quote: '"' | "'" | null = null
  const endWord = () => {
    if (has) words.push(word)
    word = ''
    has = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) out.push(words)
    words = []
  }
  for (let at = 0; at < line.length; at++) {
    const c = line[at]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && at + 1 < line.length) word += line[++at]
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      has = true
    } else if (c === '\\' && at + 1 < line.length) {
      word += line[++at]
      has = true
    } else if (c === ' ' || c === '\t') endWord()
    else if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')') endCommand()
    else {
      word += c
      has = true
    }
  }
  endCommand()
  return out
}

const base = (word: string) => (word.split('/').pop() ?? '').replace(/\.(m?js|cjs)$/, '')
const WRAPPERS = new Set(['env', 'time', 'nice', 'nohup', 'npx', 'bunx', 'pnpx', 'command', 'exec'])

/** The words with leading `VAR=value` and wrappers (`env`, `timeout 60`, `npx`, `bun x`, `pnpm exec`) taken off. */
export function unwrap(words: readonly string[]): string[] {
  let at = 0
  for (let step = 0; step < 8 && at < words.length; step++) {
    const word = words[at]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) at++
    else if (WRAPPERS.has(base(word))) {
      at++
      while (at < words.length && words[at]!.startsWith('-')) at++
    } else if (base(word) === 'timeout') at += 2
    else if ((base(word) === 'bun' && words[at + 1] === 'x') || (base(word) === 'pnpm' && words[at + 1] === 'exec')) at += 2
    else break
  }
  return words.slice(at)
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\/__tests__\//
const files = (args: readonly string[]) => args.filter((one) => !one.startsWith('-'))
const asksAbout = (args: readonly string[]) => args.some((one) => one === '--version' || one === '-v' || one === '--help' || one === '-h')

/** A unit test run is light when it names exactly one test file. */
function unitRun(args: readonly string[]): HeavyKind | null {
  if (asksAbout(args)) return null
  const named = files(args)
  return named.length === 1 && TEST_FILE.test(named[0]!) ? null : 'verify'
}

/** The script a package manager runs (`bun run test`, `npm test`, `pnpm lint`), or null. */
export function scriptOf(words: readonly string[]): string | null {
  const manager = base(words[0] ?? '')
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(manager)) return null
  let at = 1
  while ((words[at] ?? '').startsWith('-')) at++
  const sub = words[at]
  if (sub === undefined) return null
  if (sub === 'run' || sub === 'run-script') {
    at++
    while ((words[at] ?? '').startsWith('-')) at++
    return words[at] ?? null
  }
  if (manager === 'npm') return sub === 'test' || sub === 't' ? 'test' : null
  if (manager === 'bun') return null
  const builtin = ['install', 'i', 'add', 'remove', 'rm', 'update', 'up', 'exec', 'dlx', 'create', 'init', 'link', 'publish', 'outdated', 'list', 'ls', 'why', 'audit', 'store', 'help', 'upgrade', 'cache', 'config', 'workspace', 'workspaces']
  return builtin.includes(sub) ? null : sub
}

/** A script package.json does not have, by its name. */
export function byName(name: string): HeavyKind | null {
  if (/(^|:)(e2e|playwright)/.test(name)) return 'e2e'
  if (/^test/.test(name)) return 'verify'
  if (/^(typecheck|type-check|check-types|types|tsc)(:|$)/.test(name)) return 'typecheck'
  if (/^build/.test(name)) return 'build'
  return null
}

/** What one simple command is: a heavy kind, or null for light. `scriptsAt` reads a folder's package.json scripts. */
export function kindOf(raw: readonly string[], cwd: string, scriptsAt: (dir: string) => Record<string, string> | null, depth = 0): HeavyKind | null {
  const words = unwrap(raw)
  if (!words.length) return null
  const program = base(words[0]!)
  const rest = words.slice(1)
  const sub = files(rest)[0]
  if (program === 'tsc' || program === 'vue-tsc' || program === 'tsgo') return asksAbout(rest) ? null : 'typecheck'
  if (program === 'vitest') {
    const args = [...rest]
    const first = args.findIndex((one) => !one.startsWith('-'))
    if (first >= 0 && ['run', 'watch', 'related', 'dev'].includes(args[first]!)) args.splice(first, 1)
    return unitRun(args)
  }
  if (program === 'jest') return unitRun(rest)
  if (program === 'playwright') return sub === 'test' && !asksAbout(rest) ? 'e2e' : null
  if (program === 'bun' && sub === 'test') return unitRun(rest.slice(rest.indexOf('test') + 1))
  if ((program === 'vite' || program === 'next' || program === 'astro' || program === 'bun') && sub === 'build') return 'build'
  if (program === 'webpack' || program === 'webpack-cli' || program === 'rollup' || program === 'tsup') return asksAbout(rest) ? null : 'build'
  if (['bun', 'npm', 'pnpm', 'yarn'].includes(program) && (sub === 'install' || sub === 'i' || sub === 'ci' || (program === 'yarn' && rest.length === 0))) return 'task'
  const script = scriptOf(words)
  if (script !== null) {
    const scripts = scriptsAt(cwd)
    const body = scripts?.[script]
    if (body === undefined) return byName(script)
    if (depth >= 3) return byName(script) ?? 'task'
    /* The script's own line, judged the same way: "vitest run" is tests, "biome check ." is light. */
    const said = planOf(body, cwd, scriptsAt, depth + 1)
    return 'queue' in said ? said.queue : null
  }
  return null
}

/** The plan for a whole line: queue it as its heaviest part, or run it at once. */
export function planOf(line: string, cwd: string, scriptsAt: (dir: string) => Record<string, string> | null = packageScripts, depth = 0): Plan {
  let here = cwd
  const kinds: HeavyKind[] = []
  for (const words of simpleCommands(line)) {
    if (words[0] === 'cd' && words[1]) {
      here = isAbsolute(words[1]) ? words[1] : resolve(here, words[1])
      continue
    }
    const kind = kindOf(words, here, scriptsAt, depth)
    if (kind) kinds.push(kind)
  }
  const heaviest = ORDER.find((one) => kinds.includes(one))
  return heaviest ? { queue: heaviest } : { direct: 'Nothing in it is heavy work in this project.' }
}

/** A folder's package.json scripts, or null when it has none that read. */
export function packageScripts(dir: string): Record<string, string> | null {
  try {
    const scripts = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { scripts?: unknown }).scripts
    if (!scripts || typeof scripts !== 'object') return null
    return Object.fromEntries(Object.entries(scripts as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return null
  }
}

/** Whether the line asks to pass every guard: `KEHIKOT_DIRECT` set (not empty, not 0) in front, or in the environment. */
export function escaped(line: string, env: Record<string, string | undefined>): boolean {
  const on = (value: string | undefined) => value !== undefined && value !== '' && value !== '0'
  if (on(env.KEHIKOT_DIRECT)) return true
  return simpleCommands(line).some((words) => words.some((one) => /^KEHIKOT_DIRECT=/.test(one) && on(one.slice('KEHIKOT_DIRECT='.length))))
}
