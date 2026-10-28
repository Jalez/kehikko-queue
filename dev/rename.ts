#!/usr/bin/env bun
/**
 * Make this template YOUR module, once, right after you created the repository:
 *
 *   bun run rename reading-list                       # id kehikot.reading-list, name "Reading list"
 *   bun run rename reading-list --name "Reading list" --port 9530
 *
 * It rewrites, in every file of the repository: the id (`kehikot.example`), the
 * package (`kehikko-example`), the data folder and door name (`example`), the
 * skill (`/example`, `plugin/skills/example/`), the name people read
 * (`Example`) and the preferred port (the first free one on the ten-apart grid
 * from 9500, against the modules registered on this computer). Then run
 * `bun install` (the lock file names the package) and `bun test`.
 *
 * It refuses to run on a module that is no longer the template, because an id
 * is the folder a module's data is kept in: changing it later strands that data.
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { MODULE_ID, moduleFolder } from 'kehikot-module-protocol'
import { portOf, readRegistration, registryDir } from 'kehikot-module-protocol/serve'

const ROOT = join(import.meta.dirname, '..')
const FROM = { id: 'kehikot.example', pkg: 'kehikko-example', short: 'example', name: 'Example', port: 9500 }
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SKIP = new Set(['node_modules', '.git', '.kehikot', 'dist'])
/* These two spell the template's names on purpose, and keep them. */
const KEEP = new Set(['dev/rename.ts', 'test/rename.test.ts'])
const TEXT = /\.(?:ts|tsx|json|md|sh|css|yml|yaml|lock|toml)$|^\.gitignore$/

/** Everything a module is called, from the one word a person typed. Throws with a sentence. */
export function namesFor(short: string, name?: string): { id: string; pkg: string; short: string; name: string; folder: string } {
  if (!NAME.test(short)) throw new Error(`"${short}" is not a module name: lowercase letters and digits, dashes between words ("notes", "reading-list").`)
  const id = `kehikot.${short}`
  if (!MODULE_ID.test(id)) throw new Error(`"${id}" is not a module id the protocol accepts (too long?).`)
  const words = short.split('-').join(' ')
  return { id, pkg: `kehikko-${short}`, short, name: name?.trim() || words.charAt(0).toUpperCase() + words.slice(1), folder: moduleFolder(id) }
}

/** The text with every spelling of the template's names replaced. Prose that merely says "example" is left alone. */
export function renamed(text: string, to: ReturnType<typeof namesFor>, port: number): string {
  return text
    .replaceAll(FROM.id, to.id)
    .replaceAll(FROM.pkg, to.pkg)
    .replaceAll(`mcp__${FROM.short}__`, `mcp__${to.short}__`)
    .replaceAll(`.kehikot/${FROM.short}/`, `.kehikot/${to.folder}/`)
    .replaceAll(`skills/${FROM.short}/`, `skills/${to.short}/`)
    .replaceAll(`${FROM.short}-origin`, `${to.short}-origin`)
    .replace(/^name: example$/m, `name: ${to.short}`)
    .replace(/(['"`/])example\b/g, `$1${to.short}`)
    .replace(/\bExample\b/g, to.name)
    .replace(/PREFERRED_PORT = 9500\b/, `PREFERRED_PORT = ${port}`)
}

/** The first port on the ten-apart grid from 9500 that no registered module uses or prefers. */
export function freePort(taken: ReadonlySet<number>, from = FROM.port): number {
  let port = from
  while (taken.has(port)) port += 10
  return port
}

function takenPorts(): Set<number> {
  const taken = new Set<number>()
  let names: string[] = []
  try {
    names = readdirSync(registryDir())
  } catch {
    return taken
  }
  for (const file of names.filter((one) => one.endsWith('.json'))) {
    const registration = readRegistration(join(registryDir(), file))
    const port = registration ? portOf(registration.url) : null
    if (port !== null) taken.add(port)
    const manifest = registration?.dir ? join(registration.dir, 'manifest.ts') : ''
    const preferred = manifest && existsSync(manifest) ? /PREFERRED_PORT\s*=\s*(\d+)/.exec(readFileSync(manifest, 'utf8'))?.[1] : undefined
    if (preferred) taken.add(Number(preferred))
  }
  return taken
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP.has(entry)) return []
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? files(path) : TEXT.test(entry) ? [path] : []
  })
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string) => {
    const at = args.indexOf(name)
    return at >= 0 ? args.splice(at, 2)[1] : undefined
  }
  const name = flag('--name')
  const port = flag('--port')
  const [short] = args
  try {
    if (!short) throw new Error('Say what the module is called: bun run rename <name> [--name "Its name"] [--port 9530]')
    if (!readFileSync(join(ROOT, 'manifest.ts'), 'utf8').includes(`'${FROM.id}'`)) {
      throw new Error('This is no longer the template: its id was renamed already. An id is where its data lives; it is not renamed twice.')
    }
    const to = namesFor(short, name)
    const chosen = port ? Number(port) : freePort(takenPorts())
    if (!Number.isInteger(chosen) || chosen < 1024 || chosen > 65535) throw new Error(`${port} is not a port to serve on.`)
    for (const file of files(ROOT).filter((one) => !KEEP.has(relative(ROOT, one)))) {
      const before = readFileSync(file, 'utf8')
      const after = renamed(before, to, chosen)
      if (after !== before) writeFileSync(file, after)
    }
    renameSync(join(ROOT, 'plugin', 'skills', FROM.short), join(ROOT, 'plugin', 'skills', to.short))
    console.log(`Now ${to.name} (${to.id}): data in <project>/.kehikot/${to.folder}/, the skill /${to.short}, port ${chosen}.`)
    console.log('Next: bun install && bun test, then read CLAUDE.md. Files changed under', relative(process.cwd(), ROOT) || '.')
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}
