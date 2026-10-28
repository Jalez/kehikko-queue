import { describe, expect, test } from 'bun:test'

import { OFFERED, fill, serveFrom, skillDeclarations, skillTemplate, skillText } from '../skills.ts'

describe('the skills', () => {
  test('each is a person-only skill whose text names this module\'s real origin', () => {
    serveFrom('http://127.0.0.1:9573')
    for (const one of OFFERED) {
      const text = skillText(one.name)!
      expect(text).toContain('disable-model-invocation: true')
      expect(text).toContain('http://127.0.0.1:9573')
      expect(text).not.toMatch(/\{\{(origin|version)\}\}/)
    }
  })

  test('a moved port is a new version, so an installed copy is brought level', () => {
    const template = skillTemplate(OFFERED[0].name)!
    expect(fill(template, 'http://127.0.0.1:9500').version).not.toBe(fill(template, 'http://127.0.0.1:9510').version)
    serveFrom('http://127.0.0.1:9500')
    const before = skillDeclarations()[0]!.version
    serveFrom('http://127.0.0.1:9510')
    expect(skillDeclarations()[0]!.version).not.toBe(before)
  })

  test('only a loopback origin is said', () => {
    expect(() => serveFrom('https://elsewhere.test')).toThrow()
  })
})
