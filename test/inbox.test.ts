import { describe, expect, test } from 'bun:test'

import { inboxItems } from '../src/inbox.ts'
import type { Note } from '../store.ts'

const note = (over: Partial<Note>): Note => ({ id: 'a', text: 'Ask about it', epic: 'launch', parts: [], done: false, at: '2026-10-01T10:00:00Z', ...over })

describe('what goes in the Inbox', () => {
  test('every open note of the open epic, as low-priority attention at its place', () => {
    const items = inboxItems([note({}), note({ id: 'b', parts: ['design'] })], 'launch')
    expect(items.map((item) => [item.id, item.state, item.priority, item.place])).toEqual([
      ['note:a', 'attention', 'low', { epic: 'launch' }],
      ['note:b', 'attention', 'low', { epic: 'launch', parts: ['design'] }],
    ])
  })

  test('the list is whole: a done note, or another epic\'s, is simply not in it', () => {
    expect(inboxItems([note({ done: true }), note({ id: 'c', epic: 'other' })], 'launch')).toEqual([])
  })

  test('a long note is cut to the label bound, never refused', () => {
    const [item] = inboxItems([note({ text: 'x'.repeat(400) })], 'launch')
    expect(item!.label.length).toBeLessThanOrEqual(120)
  })
})
