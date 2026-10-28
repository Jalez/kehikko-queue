import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/*
 * The storage boundary: a project's data lives only under
 * `<project>/.kehikot/<module>/`, built with the protocol's `moduleDir` and
 * `moduleFile`. Kehikot's own `bun run check:storage` scans every registered
 * module for the same shapes; this is that check, here, so a mistake fails
 * this module's tests before it fails the host's. A line that really has to
 * keep machine-level state says why: `// kehikot-storage: allow <reason>`.
 */
const ROOT = join(import.meta.dirname, '..')
const SKIP = new Set(['node_modules', '.git', '.kehikot', 'dist', 'test', 'dev'])
const SOURCE = /\.(?:ts|tsx|js|mjs|sh)$/

const RULES: { rule: string; match: RegExp }[] = [
  { rule: 'a "data" folder of its own', match: /\b(?:join|resolve)\([^;]*?['"`]data['"`]/ },
  { rule: 'a path starting data/', match: /['"`]\.?\/?data\/[^'"`]*['"`]/ },
  { rule: 'a path in the home folder', match: /\bhomedir\(\)|process\.env\.HOME\b|\$HOME\//},
  { rule: 'a write next to the program', match: /(?:writeFileSync|mkdirSync|appendFileSync|Bun\.write|new Database)\([^;]*(?:import\.meta\.dir|__dirname|process\.cwd\(\))/ },
]
const ALLOW = /kehikot-storage:\s*allow\s+\S/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (SKIP.has(entry)) return []
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? sources(path) : SOURCE.test(entry) ? [path] : []
  })
}

describe('the storage boundary', () => {
  test('no source keeps project data anywhere but .kehikot/<module>/', () => {
    const found: string[] = []
    for (const file of sources(ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, at) => {
        const code = line.replace(/\/\/.*$/, '')
        if (/^\s*(?:\*|\/\*)/.test(line) || ALLOW.test(line) || ALLOW.test(lines[at - 1] ?? '')) return
        for (const { rule, match } of RULES) if (match.test(code)) found.push(`${relative(ROOT, file)}:${at + 1}: ${rule}: ${line.trim()}`)
      })
    }
    expect(found).toEqual([])
  })

  test('the store builds its path with the protocol\'s helpers', () => {
    const store = readFileSync(join(ROOT, 'store.ts'), 'utf8')
    expect(store).toMatch(/\bmoduleDir\b/)
    expect(store).toMatch(/\bmoduleFile\b/)
  })
})
