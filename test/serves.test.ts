import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isOurs } from '../doors.ts'
import { skillPath } from 'kehikot-module-protocol'

import { OFFERED } from '../skills.ts'

const read = (name: string) => readFileSync(join(import.meta.dirname, '..', name), 'utf8')

/*
 * The built server (`serve.ts`) and Vite (`vite.config.ts`) must answer the same paths: in 0.1.0 the
 * built one did not serve the skill's text. Both hand the protocol one predicate, `isOurs`, and this
 * holds that they do, and that it covers every path the page and the hosts ask.
 */
describe('Vite and the built server serve the same paths', () => {
  test('both are given the one predicate, and neither spells paths of its own', () => {
    for (const file of ['serve.ts', 'vite.config.ts']) {
      const source = read(file)
      expect(source).toContain('ours: isOurs')
      expect(source).not.toContain("'/healthz'")
    }
  })

  test('it covers the doors, every /api path the page calls, the log and each skill', () => {
    const wire = read('src/app.tsx') + read('src/wire/api.ts')
    const called = [...wire.matchAll(/'\.\/(api\/[a-z/]+)'|`\.\/(api\/[a-z/]+)\?/g)].map((one) => `/${one[1] ?? one[2]}`)
    expect(called).toContain('/api/runs')
    expect(called).toContain('/api/log')
    for (const path of ['/healthz', '/mcp', '/api/runs', '/api/output', '/api/act', '/api/log', ...called]) expect(isOurs(path)).toBe(true)
    for (const skill of OFFERED) expect(isOurs(skillPath(skill.name))).toBe(true)
    expect(isOurs('/app')).toBe(false)
  })
})
