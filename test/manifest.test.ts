import { describe, expect, test } from 'bun:test'
import { CAPABILITY_NAMES, MODULE_ID, isSkillName, manifestSchema, moduleFolder } from 'kehikot-module-protocol'

import { MANIFEST } from '../doors.ts'
import { DECLARED, ID, PREFERRED_PORT, VERSION } from '../manifest.ts'
import pkg from '../package.json'

describe('the manifest', () => {
  test('is one a host accepts, as declared and as served', () => {
    expect(manifestSchema.safeParse(DECLARED).success).toBe(true)
    expect(manifestSchema.safeParse(MANIFEST).success).toBe(true)
  })

  test('reads its version from package.json, the one place a release is numbered', () => {
    expect(VERSION).toBe(pkg.version)
    expect(MANIFEST.version).toBe(pkg.version)
  })

  test('names the module by an id that keeps its data in a folder of its own', () => {
    expect(MODULE_ID.test(ID)).toBe(true)
    expect(moduleFolder(ID)).toBe(ID.slice('kehikot.'.length))
  })

  test('says how it relates to the parts of an epic: reacts, or a partless sentence, never both', () => {
    const reacts = MANIFEST.reacts.includes('parts')
    expect(reacts !== Boolean(MANIFEST.partless)).toBe(true)
  })

  test('uses only capabilities the protocol has, and asks for none twice', () => {
    const uses = MANIFEST.declares.uses
    for (const one of uses) expect(CAPABILITY_NAMES).toContain(one as (typeof CAPABILITY_NAMES)[number])
    expect(new Set(uses).size).toBe(uses.length)
  })

  test('points at doors it answers, declares storage, and offers its skills under its own name', () => {
    expect([MANIFEST.entry, MANIFEST.health, MANIFEST.mcp?.url]).toEqual(['/app', '/healthz', '/mcp'])
    expect(MANIFEST.declares.storage).toBe(true)
    for (const skill of MANIFEST.declares.skills ?? []) {
      expect(isSkillName(skill.name)).toBe(true)
      expect(skill.name.startsWith(moduleFolder(ID))).toBe(true)
    }
  })

  test('prefers a port on the ten-apart grid', () => {
    expect(PREFERRED_PORT % 10).toBe(0)
  })
})
