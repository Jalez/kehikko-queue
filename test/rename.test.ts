import { describe, expect, test } from 'bun:test'

import { freePort, namesFor, renamed } from '../dev/rename.ts'

describe('bun run rename', () => {
  test('makes every name from the one word typed', () => {
    expect(namesFor('reading-list')).toEqual({ id: 'kehikot.reading-list', pkg: 'kehikko-reading-list', short: 'reading-list', name: 'Reading list', folder: 'reading-list' })
    expect(namesFor('notes', 'My notes').name).toBe('My notes')
    expect(() => namesFor('Reading List')).toThrow()
  })

  test('rewrites the template\'s names and leaves prose that says "example" alone', () => {
    const to = namesFor('reading-list')
    const text = [
      "export const ID = 'kehikot.example'",
      '"name": "kehikko-example"',
      'name: \'Example\',',
      'name: example',
      'allowed-tools: mcp__example__list_notes',
      'Type /example to read them, for example.',
      'kept at <project>/.kehikot/example/notes.json',
      'export const PREFERRED_PORT = 9500',
    ].join('\n')
    expect(renamed(text, to, 9530).split('\n')).toEqual([
      "export const ID = 'kehikot.reading-list'",
      '"name": "kehikko-reading-list"',
      "name: 'Reading list',",
      'name: reading-list',
      'allowed-tools: mcp__reading-list__list_notes',
      'Type /reading-list to read them, for example.',
      'kept at <project>/.kehikot/reading-list/notes.json',
      'export const PREFERRED_PORT = 9530',
    ])
  })

  test('takes the first free port on the ten-apart grid', () => {
    expect(freePort(new Set([9500, 9510]))).toBe(9520)
  })
})
