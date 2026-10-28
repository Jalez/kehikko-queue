import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NOTE_MAX, editNotes, readNotes } from '../store.ts'

const home = mkdtempSync(join(tmpdir(), 'kehikko-example-store-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

function project(name: string): string {
  const dir = join(home, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('the store', () => {
  test('notes are kept inside the project, under .kehikot/example/', () => {
    const dir = project('round-trip')
    expect(readNotes(dir)).toEqual({ ok: true, value: [] })
    const added = editNotes(dir, { op: 'add', text: 'one', epic: 'e', parts: [] })
    expect(added.ok).toBe(true)
    expect(existsSync(join(dir, '.kehikot', 'example', 'notes.json'))).toBe(true)
    const id = added.ok ? added.value[0]!.id : ''
    expect(editNotes(dir, { op: 'done', id, done: true }).ok).toBe(true)
    expect(readNotes(dir).ok && readNotes(dir)).toMatchObject({ value: [{ text: 'one', done: true }] })
    expect(editNotes(dir, { op: 'remove', id }).ok).toBe(true)
    expect(readNotes(dir)).toEqual({ ok: true, value: [] })
  })

  test('with no project there is nowhere to read or write', () => {
    expect(readNotes(null).ok).toBe(false)
    expect(editNotes(null, { op: 'add', text: 'x', epic: null, parts: [] }).ok).toBe(false)
    expect(editNotes('relative/path', { op: 'add', text: 'x', epic: null, parts: [] }).ok).toBe(false)
  })

  test('an empty or overlong note is refused, not clipped', () => {
    const dir = project('bounds')
    expect(editNotes(dir, { op: 'add', text: '   ', epic: null, parts: [] }).ok).toBe(false)
    expect(editNotes(dir, { op: 'add', text: 'x'.repeat(NOTE_MAX + 1), epic: null, parts: [] }).ok).toBe(false)
  })

  test('a .kehikot that points out of the project is refused', () => {
    const dir = project('escaping')
    const elsewhere = project('elsewhere')
    symlinkSync(elsewhere, join(dir, '.kehikot'))
    expect(editNotes(dir, { op: 'add', text: 'x', epic: null, parts: [] }).ok).toBe(false)
    expect(existsSync(join(elsewhere, 'example'))).toBe(false)
  })
})
