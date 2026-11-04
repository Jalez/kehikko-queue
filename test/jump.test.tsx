import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { Screen } from '../src/app.tsx'
import type { Origin } from '../queue/origin.ts'
import { streams } from './streams.ts'
import type { Api, Overview } from '../src/wire/api.ts'
import type { Host } from '../src/wire/use-kehikot.ts'
import { aRun } from './inbox.test.ts'

afterEach(cleanup)

const machine = { cores: 12, load: 3.2, most: 2, loadAbove: 9, waitMinutes: 10 }
const settle = () => act(async () => void (await new Promise((done) => setTimeout(done, 20))))

function setup(runs: Overview['runs'], over: Partial<Host> = {}, answer: unknown = { outcome: 'moved', epic: 'queue', why: '' }) {
  const asked: { method: string; params: unknown }[] = []
  const host: Host = {
    where: 'hosted',
    project: 'p',
    projectPath: '/p',
    projectId: null,
    epic: 'queue',
    parts: [{ id: 'p1', heading: 'methods' }] as unknown as Host['parts'],
    theme: 'light',
    header: () => {},
    activity: () => {},
    request: async (method, params) => {
      asked.push({ method, params })
      return answer
    },
    picked: [],
    ...over,
  }
  const api: Api = {
    ...streams().api,
    runs: async () => ({ runs, machine }),
    output: async (id) => ({ text: `output of ${id}`, next: 10, size: 10 }),
    cancel: async () => ({ runs, machine }),
    move: async () => ({ runs, machine }),
  }
  render(<Screen host={host} api={api} showing="all" now={() => 5000} />)
  return asked
}

const origin: Origin = { project: '/p', projectName: 'Scratch', epic: 'queue', parts: ['p1'], kehikko: 'k1', kehikkoName: 'Wide', session: 's1', branch: 'main' }
const rowOf = (id: string) => document.querySelector(`[data-run="${id}"]`) as HTMLElement
const jumpIn = (id: string) => within(rowOf(id)).getByRole('button', { name: 'Go to where this run came from' }) as HTMLButtonElement
const outputButton = (label: string) => screen.getByRole('button', { name: `Output of “${label}”`, hidden: true })

describe('the jump-into button', () => {
  test('is enabled for a run from the open project, with a tooltip naming where it goes', async () => {
    setup([aRun({ id: 'a', origin })])
    await settle()
    expect(jumpIn('a').disabled).toBe(false)
    expect(within(rowOf('a')).getByTestId('jump-tip').getAttribute('title')).toBe('Go to Wide · queue · methods')
  })

  test('asks the host view.goto with the epic, the parts and the kehikko', async () => {
    const asked = setup([aRun({ id: 'a', origin })])
    await settle()
    fireEvent.click(jumpIn('a'))
    await settle()
    expect(asked).toEqual([{ method: 'view.goto', params: { epic: 'queue', parts: ['p1'], kehikko: 'k1', show: { subject: 'agent-session', id: 's1' } } }])
    expect(screen.queryByTestId('jump-said')).toBeNull()
  })

  test('says the host\'s sentence when it would not go', async () => {
    setup([aRun({ id: 'a', origin })], {}, { outcome: 'no-such-target', epic: null, why: 'There is no kehikko k1.' })
    await settle()
    fireEvent.click(jumpIn('a'))
    await settle()
    expect(screen.getByTestId('jump-said').textContent).toBe('There is no kehikko k1.')
  })

  test('is disabled, with the reason, for a run started outside any project', async () => {
    const asked = setup([aRun({ id: 'a', origin: null, project: null, epic: null, cwd: '/Users/me/scratch/thing' })])
    await settle()
    expect(jumpIn('a').disabled).toBe(true)
    expect(within(rowOf('a')).getByTestId('jump-tip').getAttribute('title')).toBe('Started outside any Kehikot project: thing')
    fireEvent.click(jumpIn('a'))
    await settle()
    expect(asked).toEqual([])
  })

  test('is enabled for a run of another project, its tooltip naming the project, and asks with project and show', async () => {
    const other = { ...origin, project: '/work/other', projectId: 'project-other-1', projectName: 'Other' }
    const asked = setup([aRun({ id: 'a', origin: other, project: '/work/other' })])
    await settle()
    expect(jumpIn('a').disabled).toBe(false)
    expect(within(rowOf('a')).getByTestId('jump-tip').getAttribute('title')).toBe('Go to Other · Wide · queue · methods (in another project)')
    fireEvent.click(jumpIn('a'))
    await settle()
    expect(asked).toEqual([
      {
        method: 'view.goto',
        params: { epic: 'queue', parts: ['p1'], kehikko: 'k1', project: 'project-other-1', show: { subject: 'agent-session', id: 's1' } },
      },
    ])
  })

  test('a run kept by 0.2.0, with no project id, names the project by its folder', async () => {
    const asked = setup([aRun({ id: 'a', origin: { ...origin, project: '/work/other', projectName: null, session: null }, project: '/work/other' })])
    await settle()
    expect(within(rowOf('a')).getByTestId('jump-tip').getAttribute('title')).toBe('Go to other · Wide · queue · methods (in another project)')
    fireEvent.click(jumpIn('a'))
    await settle()
    expect(asked).toEqual([{ method: 'view.goto', params: { epic: 'queue', parts: ['p1'], kehikko: 'k1', project: '/work/other' } }])
  })

  test('the host\'s refusal of another project is said', async () => {
    setup([aRun({ id: 'a', origin: { ...origin, project: '/gone' }, project: '/gone' })], {}, { outcome: 'declined', epic: null, why: 'Kehikot does not have that project, so it stayed where it is.' })
    await settle()
    fireEvent.click(jumpIn('a'))
    await settle()
    expect(screen.getByTestId('jump-said').textContent).toBe('Kehikot does not have that project, so it stayed where it is.')
  })
})

describe('the output drawer', () => {
  const two = () => [aRun({ id: 'f1', label: 'first', origin }), aRun({ id: 'f2', label: 'second', origin })]

  test('no output is inline; each failed run has its own Output button', async () => {
    setup(two())
    await settle()
    expect(screen.queryAllByTestId('output')).toHaveLength(0)
    expect(screen.queryByText('Hide output')).toBeNull()
    expect(outputButton('first')).toBeTruthy()
    expect(outputButton('second')).toBeTruthy()
  })

  test('opens for the run asked about: its label, state, origin, jump and output', async () => {
    setup(two())
    await settle()
    fireEvent.click(outputButton('second'))
    await settle()
    const drawer = screen.getByTestId('drawer')
    expect(drawer.getAttribute('data-run')).toBe('f2')
    expect(drawer.textContent).toContain('second')
    expect(drawer.textContent).toContain('Failed (exit 3)')
    expect(within(drawer).getByTestId('drawer-origin').textContent).toContain('branch main')
    expect(within(drawer).getByRole('button', { name: 'Go to where this run came from' })).toBeTruthy()
    expect(within(drawer).getByTestId('output').textContent).toBe('output of f2')
  })

  test('opening one run never changes another (the old inline toggle shared one flag)', async () => {
    setup(two())
    await settle()
    fireEvent.click(outputButton('first'))
    await settle()
    fireEvent.keyDown(screen.getByTestId('drawer'), { key: 'Escape' })
    await settle()
    expect(screen.queryByTestId('drawer')).toBeNull()
    fireEvent.click(outputButton('second'))
    await settle()
    expect(screen.getByTestId('drawer').getAttribute('data-run')).toBe('f2')
    expect(screen.getAllByTestId('output')).toHaveLength(1)
    expect(screen.getByTestId('output').textContent).toBe('output of f2')
  })

  test('switching to another run replaces the content, and there is only ever one drawer', async () => {
    setup(two())
    await settle()
    fireEvent.click(outputButton('first'))
    await settle()
    expect(screen.getByTestId('output').textContent).toBe('output of f1')
    fireEvent.click(outputButton('second'))
    await settle()
    expect(screen.getAllByTestId('drawer')).toHaveLength(1)
    expect(screen.getByTestId('drawer').getAttribute('data-run')).toBe('f2')
    expect(screen.getByTestId('output').textContent).toBe('output of f2')
  })

  test('Esc closes it', async () => {
    setup(two())
    await settle()
    fireEvent.click(outputButton('first'))
    await settle()
    fireEvent.keyDown(screen.getByTestId('drawer'), { key: 'Escape' })
    await settle()
    expect(screen.queryByTestId('drawer')).toBeNull()
  })

  test('Copy and, for a log that was cut, Open full log', async () => {
    const written: string[] = []
    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void written.push(text) } })
    const runs = [aRun({ id: 'f1', label: 'first', origin })]
    setup(runs)
    await settle()
    fireEvent.click(outputButton('first'))
    await settle()
    expect(screen.queryByText('Open full log')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Copy/ }))
    await settle()
    expect(written).toEqual(['output of f1'])
    cleanup()
    const cutApi: Api = {
      ...streams().api,
      runs: async () => ({ runs, machine }),
      output: async () => ({ text: 'head\n… 99 bytes of output left out here …\ntail', next: 5, size: 5 }),
      cancel: async () => ({ runs, machine }),
      move: async () => ({ runs, machine }),
    }
    render(<Screen host={{ where: 'hosted', project: 'p', projectPath: '/p', projectId: null, epic: 'queue', parts: [], theme: 'light', header: () => {}, activity: () => {}, request: async () => ({}), picked: [] }} api={cutApi} now={() => 5000} />)
    await settle()
    fireEvent.click(outputButton('first'))
    await settle()
    expect(screen.getByText('Open full log').getAttribute('href')).toBe('./api/log?id=f1')
  })
})
