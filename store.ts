import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { LIMITS, kehikotDir, moduleDir, moduleFile, within } from 'kehikot-module-protocol'

import { ID } from './manifest.ts'

/**
 * This module's material, kept inside the project it is about:
 * `<project>/.kehikot/example/notes.json`.
 *
 * The folder and the join are the protocol's (`moduleDir`, `moduleFile`), so every
 * module agrees on where data lives, and `bun test` checks nothing here builds a
 * path of its own (test/storage-boundary.test.ts). There is no default project:
 * with none, every read is empty and every write refused, because a guessed
 * folder is one where work is written and never seen again.
 *
 * Both sides are realpath'd before the containment check, so a `.kehikot` that
 * is a symlink out of the project is refused rather than followed.
 */
export const FILE = 'notes'

/** One note: what it says, the epic and parts it was written in, and whether it is done. */
export interface Note {
  id: string
  text: string
  /** The epic it belongs to; `null` for the project as a whole. */
  epic: string | null
  /** The ids of the parts picked when it was written. Empty: the whole epic. */
  parts: string[]
  done: boolean
  /** When it was written, as an ISO time. */
  at: string
}

/** What a page may ask of the store. One edit per call. */
export type Edit =
  | { op: 'add'; text: string; epic: string | null; parts: string[] }
  | { op: 'done'; id: string; done: boolean }
  | { op: 'remove'; id: string }

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** A note's text is a line or two, not a document. */
export const NOTE_MAX = 500
/** A project keeps at most this many notes; the oldest done ones are the ones to remove. */
export const NOTES_MAX = 500

const NO_PROJECT = 'Nothing has said which project this is, so there is nowhere to keep anything. Open a project in Kehikot.'

/** Every note kept for one project, oldest first. */
export function readNotes(projectPath: string | null | undefined): Result<Note[]> {
  const file = fileFor(projectPath, false)
  if (!file.ok) return file
  if (!existsSync(file.value)) return { ok: true, value: [] }
  try {
    const parsed = JSON.parse(readFileSync(file.value, 'utf8')) as { notes?: unknown }
    return { ok: true, value: Array.isArray(parsed.notes) ? parsed.notes.filter(isNote) : [] }
  } catch {
    return { ok: false, error: `${file.value} is not readable JSON. Nothing was changed; fix or remove the file.` }
  }
}

/** Apply one edit and keep the result. Written to a temporary file and renamed, so a crash never leaves half a file. */
export function editNotes(projectPath: string | null | undefined, edit: Edit): Result<Note[]> {
  const read = readNotes(projectPath)
  if (!read.ok) return read
  const next = applied(read.value, edit)
  if (!next.ok) return next
  const file = fileFor(projectPath, true)
  if (!file.ok) return file
  const temporary = `${file.value}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ notes: next.value }, null, 2)}\n`)
  renameSync(temporary, file.value)
  return next
}

/** The edit, as a pure function of the list. Refused with a sentence, never clipped. */
export function applied(notes: readonly Note[], edit: Edit): Result<Note[]> {
  if (edit.op === 'add') {
    const text = edit.text.trim()
    if (!text) return { ok: false, error: 'A note needs some words.' }
    if (text.length > NOTE_MAX) return { ok: false, error: `A note is at most ${NOTE_MAX} characters; this one is ${text.length}.` }
    if (notes.length >= NOTES_MAX) return { ok: false, error: `This project already keeps ${NOTES_MAX} notes. Remove some done ones first.` }
    const parts = edit.parts.slice(0, LIMITS.PLACE_PARTS)
    return { ok: true, value: [...notes, { id: randomUUID(), text, epic: edit.epic, parts, done: false, at: new Date().toISOString() }] }
  }
  if (!notes.some((note) => note.id === edit.id)) return { ok: false, error: 'That note is not here any more.' }
  if (edit.op === 'done') return { ok: true, value: notes.map((note) => (note.id === edit.id ? { ...note, done: edit.done } : note)) }
  return { ok: true, value: notes.filter((note) => note.id !== edit.id) }
}

function isNote(value: unknown): value is Note {
  const note = value as Partial<Note> | null
  return (
    !!note
    && typeof note.id === 'string'
    && typeof note.text === 'string'
    && (note.epic === null || typeof note.epic === 'string')
    && Array.isArray(note.parts)
    && note.parts.every((part) => typeof part === 'string')
    && typeof note.done === 'boolean'
    && typeof note.at === 'string'
  )
}

/** The data file's path, checked to resolve inside the project. `make` creates the folder first. */
function fileFor(projectPath: string | null | undefined, make: boolean): Result<string> {
  const root = projectRoot(projectPath)
  if (!root.ok) return root
  const dir = moduleDir(root.value, ID)!
  const levels = [kehikotDir(root.value)!, dir]
  /* Checked before making anything, so a folder that escapes is never written into, and again after. */
  const escaped = escapesAny(root.value, levels)
  if (escaped) return { ok: false, error: escaped }
  if (make) {
    mkdirSync(dir, { recursive: true })
    const after = escapesAny(root.value, levels)
    if (after) return { ok: false, error: after }
  }
  const file = moduleFile(root.value, ID, FILE)!
  if (existsSync(file)) {
    const out = escapes(root.value, file)
    if (out) return { ok: false, error: out }
  }
  return { ok: true, value: file }
}

function projectRoot(projectPath: string | null | undefined): Result<string> {
  const raw = typeof projectPath === 'string' ? projectPath.trim() : ''
  if (!raw) return { ok: false, error: NO_PROJECT }
  if (!isAbsolute(raw)) return { ok: false, error: `"${raw}" is not an absolute path.` }
  try {
    const real = realpathSync(raw)
    if (!statSync(real).isDirectory()) return { ok: false, error: `"${raw}" is not a folder.` }
    return { ok: true, value: real }
  } catch {
    return { ok: false, error: `There is no folder at "${raw}" on this computer.` }
  }
}

function escapesAny(root: string, paths: string[]): string | null {
  for (const path of paths) {
    if (!existsSync(path)) continue
    const out = escapes(root, path)
    if (out) return out
  }
  return null
}

function escapes(root: string, child: string): string | null {
  let real: string
  try {
    real = realpathSync(child)
  } catch {
    return `${child} could not be resolved, so nothing is read or written through it.`
  }
  return within(root, real) ? null : `${child} resolves to ${real}, outside the project. Refused rather than followed.`
}
