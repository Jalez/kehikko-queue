import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'

import { EPIC_SLUG, LIMITS, readTrackerRef } from 'kehikot-module-protocol'

import { ARGV_BYTES_MOST, ARGV_MOST, LABEL_MOST, RUN_KINDS, type Kind } from './queue.ts'

/**
 * What a caller may ask the queue to run, checked before anything is held: the command (an argv, or
 * one line for a login shell), the folder, the kind, the label and the refs. Every refusal is a
 * sentence saying what to send instead. Pure but for asking the disk whether the folder is there.
 */

export type Checked<T> = { ok: true; value: T } | { ok: false; why: string }

export function argvOf(command: unknown, shell: string): Checked<string[]> {
  if (typeof command === 'string') {
    const line = command.trim()
    if (!line) return { ok: false, why: 'command is the command to run: an array of words (["bun", "test"]) or one line for your shell.' }
    if (line.length > ARGV_BYTES_MOST) return { ok: false, why: 'That command is too long.' }
    /* One line is run by the person's login shell, so it finds what their terminal finds. */
    return { ok: true, value: [shell, '-lc', line] }
  }
  if (!Array.isArray(command) || !command.length || command.some((one) => typeof one !== 'string')) {
    return { ok: false, why: 'command is the command to run: an array of words (["bun", "test"]) or one line for your shell.' }
  }
  if (command.length > ARGV_MOST || command.reduce((n: number, one: string) => n + one.length, 0) > ARGV_BYTES_MOST) return { ok: false, why: 'That command is too long.' }
  if (!(command[0] as string).trim()) return { ok: false, why: 'The command\'s first word is the program to run.' }
  return { ok: true, value: command as string[] }
}

export function cwdOf(cwd: unknown): Checked<string> {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > LIMITS.PATH) return { ok: false, why: 'cwd is the absolute folder to run it in.' }
  try {
    if (!statSync(cwd).isDirectory()) return { ok: false, why: `${cwd} is not a folder.` }
  } catch {
    return { ok: false, why: `${cwd} is not there.` }
  }
  return { ok: true, value: cwd }
}

export function kindOf(kind: unknown): Checked<Kind> {
  if (kind === undefined || kind === null) return { ok: true, value: 'other' }
  return (RUN_KINDS as readonly unknown[]).includes(kind) ? { ok: true, value: kind as Kind } : { ok: false, why: `kind is one of ${RUN_KINDS.join(', ')}: push for a hook somebody waits on, verify or review for background checks.` }
}

export function labelOf(label: unknown, argv: readonly string[]): Checked<string> {
  const said = typeof label === 'string' ? label.trim().replace(/\s+/g, ' ') : ''
  if (said.length > LABEL_MOST) return { ok: false, why: `label is at most ${LABEL_MOST} characters.` }
  if (said) return { ok: true, value: said }
  /* No label: the command's own words, which is what a person would call it. */
  const words = argv[1] === '-lc' ? (argv[2] ?? '') : argv.join(' ')
  const fallback = words.length > LABEL_MOST ? `${words.slice(0, LABEL_MOST - 1)}…` : words
  return fallback ? { ok: true, value: fallback } : { ok: false, why: 'label says what the run is: "pre-push monorepo".' }
}

/** Refs, each one the tracker reading could spell (`!3907`, `gh#12`, `#4`). */
export function refsOf(refs: unknown): Checked<string[]> {
  const given = refs === undefined || refs === null ? [] : typeof refs === 'string' ? [refs] : refs
  if (!Array.isArray(given)) return { ok: false, why: 'ref is the change or issue the run is for: "!3907", "gh#12".' }
  const out: string[] = []
  for (const one of given) {
    const ref = typeof one === 'string' ? one.trim() : ''
    if (!ref || !readTrackerRef(ref)) return { ok: false, why: `${JSON.stringify(String(one).slice(0, 40))} is not a ref: spell it as the tracker reading does, "!3907", "#12", "gh#12".` }
    if (!out.includes(ref)) out.push(ref)
  }
  if (out.length > LIMITS.RUN_REFS) return { ok: false, why: `At most ${LIMITS.RUN_REFS} refs.` }
  return { ok: true, value: out }
}

export function epicOf(epic: unknown): string | null {
  return typeof epic === 'string' && EPIC_SLUG.test(epic) ? epic : null
}
