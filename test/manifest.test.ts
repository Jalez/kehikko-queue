import { absentSaysOf, agentSaysOf } from 'kehikot-module-protocol'
import { describe, expect, test } from 'bun:test'
import { CAPABILITY_NAMES, HELP_LIMITS, MODULE_ID, helpOf, isSkillName, manifestSchema, moduleFolder } from 'kehikot-module-protocol'

import { MANIFEST } from '../doors.ts'
import { DECLARED, HELP, ID, PREFERRED_PORT, VERSION } from '../manifest.ts'
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

describe('what agent sessions are told (protocol 2.36.0)', () => {
  test('where it is, when to use it; where it is not, not to run heavy suites directly', () => {
    const parsed = manifestSchema.parse(DECLARED)
    expect(agentSaysOf(parsed)).toContain('Run heavy commands — tests, builds, big installs — through the Queue')
    expect(absentSaysOf(parsed)).toBe("Don't start heavy commands (test suites, builds, big installs) directly. If the person insists, suggest adding Queue to this kehikko so runs don't collide.")
    for (const line of [parsed.agentSays, parsed.absentSays]) expect(line!.length).toBeLessThanOrEqual(200)
  })
})

describe('How to use (protocol 2.52.0)', () => {
  test('is declared, within the protocol’s bounds, and read back whole as plain one-line text', () => {
    const help = helpOf(MANIFEST)
    expect(help).toEqual(HELP)
    expect(HELP.summary.length).toBeLessThanOrEqual(HELP_LIMITS.SUMMARY)
    expect(HELP.sections.length).toBeLessThanOrEqual(HELP_LIMITS.SECTIONS)
    for (const section of HELP.sections) {
      expect(section.title.length).toBeLessThanOrEqual(HELP_LIMITS.TITLE)
      expect(section.points.length).toBeLessThanOrEqual(HELP_LIMITS.POINTS)
      for (const point of section.points) {
        expect(point.length).toBeLessThanOrEqual(HELP_LIMITS.POINT)
        expect(point).not.toMatch(/[<>]|https?:|\]\(/)
      }
    }
  })

  test('says what it shows, how to use it and what agents can do', () => {
    expect(HELP.sections.map((section) => section.title)).toEqual(expect.arrayContaining(['What it shows', 'How to use it', 'What agents can do']))
  })
})
