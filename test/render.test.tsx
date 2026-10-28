import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { EpicPart } from 'kehikot-module-protocol'

import { Screen } from '../src/app.tsx'
import type { Api } from '../src/wire/api.ts'
import type { Host } from '../src/wire/use-kehikot.ts'
import type { Edit, Note } from '../store.ts'

afterEach(cleanup)

const parts: EpicPart[] = [
  { id: 'design', heading: 'Design', refs: [], picked: false },
  { id: 'build', heading: 'Build', refs: [], picked: false },
]

function host(over: Partial<Host> = {}): Host {
  return {
    where: 'hosted',
    project: 'Thesis',
    projectPath: '/work/thesis',
    epic: 'launch',
    parts,
    picked: [],
    theme: 'light',
    header: () => {},
    activity: () => {},
    ...over,
  }
}

const note = (id: string, text: string, notePart: string[] = [], done = false): Note => ({ id, text, epic: 'launch', parts: notePart, done, at: '2026-10-01T10:00:00Z' })

function fakeApi(notes: Note[], edits: Edit[] = []): Api {
  return { read: () => Promise.resolve(notes), edit: (_, one) => (edits.push(one), Promise.resolve(notes)) }
}

describe('the screen', () => {
  test('says where the host put it: project, epic, and "the whole epic" when no part is picked', async () => {
    render(<Screen host={host()} api={fakeApi([])} />)
    expect(screen.getByTestId('project').textContent).toBe('Thesis')
    expect(screen.getByTestId('epic').textContent).toBe('launch')
    expect(screen.getByTestId('parts').textContent).toBe('the whole epic')
    await waitFor(() => screen.getByText('No open notes.'))
  })

  test('narrows to the picked parts, and says so when the pick leaves nothing', async () => {
    const picked = parts.map((one) => ({ ...one, picked: one.id === 'build' }))
    render(<Screen host={host({ parts: picked, picked: ['Build'] })} api={fakeApi([note('a', 'In design', ['design']), note('b', 'Everywhere')])} />)
    await waitFor(() => screen.getByText('Everywhere'))
    expect(screen.queryByText('In design')).toBeNull()
    cleanup()
    render(<Screen host={host({ parts: picked, picked: ['Build'] })} api={fakeApi([note('a', 'In design', ['design'])])} />)
    await waitFor(() => screen.getByText('No note is in the picked part.'))
  })

  test('a note is drawn as text, never as markup', async () => {
    render(<Screen host={host()} api={fakeApi([note('a', '<b>bold</b>')])} />)
    await waitFor(() => screen.getByText('<b>bold</b>'))
  })

  test('a new note is filed under the parts picked when it was written', async () => {
    const edits: Edit[] = []
    const picked = parts.map((one) => ({ ...one, picked: one.id === 'design' }))
    render(<Screen host={host({ parts: picked, picked: ['Design'] })} api={fakeApi([], edits)} />)
    await waitFor(() => screen.getByLabelText('A new note'))
    fireEvent.change(screen.getByLabelText('A new note'), { target: { value: 'Pick a colour' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(edits).toEqual([{ op: 'add', text: 'Pick a colour', epic: 'launch', parts: ['design'] }]))
  })

  test('the open notes are reported to the Inbox, whole', async () => {
    const reported: unknown[][] = []
    render(<Screen host={host({ activity: (items) => reported.push(items) })} api={fakeApi([note('a', 'Open'), note('b', 'Done', [], true)])} />)
    await waitFor(() => expect(reported.at(-1)?.length).toBe(1))
  })

  test('each not-ready moment is the shared cover, with nothing to save into', () => {
    const none = { projectPath: null, project: null, epic: null }
    for (const [where, state] of [['listening', 'waiting'], ['unhosted', 'unhosted'], ['hosted', 'no-project']] as const) {
      const { container } = render(<Screen host={host({ ...none, where })} api={fakeApi([])} />)
      expect(container.querySelector('[data-cover]')?.getAttribute('data-cover')).toBe(state)
      expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
      cleanup()
    }
  })

  test('alone, the page draws its own header; hosted, the host does', () => {
    render(<Screen host={host({ where: 'unhosted' })} api={fakeApi([])} />)
    expect(screen.getByRole('button', { name: /View/ })).toBeDefined()
    cleanup()
    render(<Screen host={host()} api={fakeApi([])} />)
    expect(screen.queryByRole('button', { name: /View/ })).toBeNull()
  })
})
