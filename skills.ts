import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { skillPath, skillTextIssue, type ModuleSkill } from 'kehikot-module-protocol'
import { originFor, preferred } from 'kehikot-module-protocol/serve'

import { PREFERRED_PORT } from './manifest.ts'

/**
 * The Claude Code skills this module offers (protocol 2.5.0, `declares.skills`).
 *
 * Each is ONE file, `plugin/skills/<name>/SKILL.md`, and a template: where it says
 * `{{origin}}` the origin this process really serves on is written (`serveFrom`,
 * from the port Vite ended up bound to), and where it says `{{version}}` the
 * skill's version. The version is the first twelve hex digits of the sha256 of
 * the text with the origin filled in, so a changed text or a moved port makes an
 * installed copy "outdated" and Kehikot's Settings sync brings it level.
 *
 * A host fetches the text at `skillPath(name)` from this module's registered
 * origin, shows it, and installs it on the person's press (or keeps it installed
 * when they chose that in Settings). This module installs nothing itself.
 *
 * Name every skill after the module (`example`, `example-<verb>`), so a person
 * can tell from `/example…` whose it is.
 */

export const PLUGIN_DIR = join(import.meta.dirname, 'plugin')
export const ORIGIN_SLOT = '{{origin}}'
export const VERSION_SLOT = '{{version}}'

export const OFFERED = [
  {
    name: 'example',
    summary: 'Type /example: an agent reads the notes kept about this epic and tells you which are still open.',
  },
] as const

const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/

let served = originFor(preferred(PREFERRED_PORT))

/** Say the origin this process is really on (`http://127.0.0.1:<port>`). Refuses anything else. */
export function serveFrom(origin: string): void {
  if (!LOOPBACK_ORIGIN.test(origin)) throw new Error(`not a loopback origin: ${JSON.stringify(origin)}`)
  served = origin
}

export const servedOrigin = (): string => served

export function skillTemplate(name: string): string | null {
  if (!OFFERED.some((one) => one.name === name)) return null
  return readFileSync(join(PLUGIN_DIR, 'skills', name, 'SKILL.md'), 'utf8')
}

const sha12 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** A template filled in for one origin: the text as served, and its version. */
export function fill(template: string, origin: string): { text: string; version: string } {
  const placed = template.replaceAll(ORIGIN_SLOT, origin)
  const version = sha12(placed)
  return { text: placed.replaceAll(VERSION_SLOT, version), version }
}

export function skillText(name: string, origin = served): string | null {
  const template = skillTemplate(name)
  return template === null ? null : fill(template, origin).text
}

/** What the manifest declares: each skill's name, summary and version for `origin`. */
export function skillDeclarations(origin = served): ModuleSkill[] {
  return OFFERED.map((one) => ({ name: one.name, summary: one.summary, version: fill(skillTemplate(one.name)!, origin).version }))
}

/** The skill a path asks for, or null for a path that is not one of ours (or text that would not pass). */
export function skillAt(path: string): { name: string; text: string } | null {
  for (const one of OFFERED) {
    if (skillPath(one.name) !== path) continue
    const text = skillText(one.name)
    if (text === null || skillTextIssue(text, one.name)) return null
    return { name: one.name, text }
  }
  return null
}

export const isSkillPath = (path: string): boolean => OFFERED.some((one) => skillPath(one.name) === path)
