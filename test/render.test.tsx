import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { Screen } from '../src/app.tsx'
import type { Api, Overview } from '../src/wire/api.ts'
import type { Host } from '../src/wire/use-kehikot.ts'
import { aRun } from './inbox.test.ts'

afterEach(cleanup)

const host = (over: Partial<Host> = {}): Host => ({
  where: 'hosted',
  project: 'p',
  projectPath: '/p',
  epic: 'queue',
  parts: [],
  theme: 'light',
  header: () => {},
  activity: () => {},
  request: async () => ({}),
  picked: [],
  ...over,
})

const machine = { cores: 12, load: 3.2, most: 2, loadAbove: 9, waitMinutes: 10 }

function fakeApi(runs: Overview['runs']) {
  const said: string[] = []
  const api: Api = {
    runs: async () => ({ runs, machine }),
    output: async (id) => ({ text: `output of ${id}\n<b>not markup</b>`, next: 10, size: 10 }),
    cancel: async (id) => {
      said.push(`cancel ${id}`)
      return { runs, machine }
    },
    move: async (id, to) => {
      said.push(`move ${id} ${to}`)
      return { runs, machine }
    },
  }
  return { api, said }
}

const settle = () => act(async () => {
  await new Promise((done) => setTimeout(done, 20))
})

describe('the Test runs page', () => {
  test('lists waiting, running and finished runs with where each came from; its output is in a drawer, not inline', async () => {
    const runs = [
      aRun({ id: 'w1', state: 'queued', startedAt: null, finishedAt: null, exit: null, waiting: 'Next: waiting for one of the 2 running to finish (2 at once).', position: 1 }),
      aRun({ id: 'u1', state: 'running', finishedAt: null, exit: null, label: 'unit' }),
      aRun({ id: 'f1', state: 'failed', label: '<script>x</script>' }),
      aRun({ id: 'p1', state: 'passed', exit: 0, label: 'lint' }),
    ]
    const { api } = fakeApi(runs)
    render(<Screen host={host()} api={api} now={() => 5000} />)
    await settle()
    expect(screen.getByRole('region', { name: 'Waiting' }).textContent).toContain('Next: waiting for one of the 2 running')
    expect(screen.getByRole('region', { name: 'Running' }).textContent).toContain('unit')
    const finished = screen.getByRole('region', { name: 'Finished' })
    expect(finished.textContent).toContain('Failed (exit 3)')
    expect(finished.textContent).toContain('Passed')
    expect(finished.textContent).toContain('From pre-push hook, in /p · epic queue · for !3907')
    /* The label is text, never markup. */
    expect(document.querySelector('script')).toBeNull()
    expect(finished.textContent).toContain('<script>x</script>')
    /* No output is open inline, whatever the state: each row has an Output button and the drawer is closed. */
    expect(screen.queryAllByTestId('output')).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: /^Output of / })).toHaveLength(3)
    expect(screen.getByTestId('machine').textContent).toContain('12 cores · load 3.2 · at most 2 at once')
  })

  test('the person cancels and reorders', async () => {
    const runs = [
      aRun({ id: 'w1', label: 'first', state: 'queued', startedAt: null, finishedAt: null, exit: null, position: 1 }),
      aRun({ id: 'w2', label: 'second', state: 'queued', startedAt: null, finishedAt: null, exit: null, position: 2 }),
    ]
    const { api, said } = fakeApi(runs)
    render(<Screen host={host()} api={api} now={() => 5000} />)
    await settle()
    expect((screen.getByRole('button', { name: 'Move “first” up' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Move “second” to the top' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel “first”' }))
    await settle()
    expect(said).toEqual(['move w2 top', 'cancel w1'])
  })

  test('this project only, or every project', async () => {
    const runs = [aRun({ id: 'a', label: 'mine' }), aRun({ id: 'b', label: 'theirs', project: '/other' })]
    const { api } = fakeApi(runs)
    const here = render(<Screen host={host()} api={api} showing="here" now={() => 5000} />)
    await settle()
    expect(here.container.textContent).toContain('mine')
    expect(here.container.textContent).not.toContain('theirs')
    here.unmount()
    const all = render(<Screen host={host()} api={api} showing="all" now={() => 5000} />)
    await settle()
    expect(all.container.textContent).toContain('theirs')
  })

  test('reports every run of the last day to the Inbox, a failure as needing the person', async () => {
    const reported: unknown[] = []
    const { api } = fakeApi([aRun()])
    render(<Screen host={host({ activity: (items) => reported.push(items) })} api={api} now={() => 5000} />)
    await settle()
    expect(reported.at(-1)).toEqual([expect.objectContaining({ id: 'run:r1', state: 'attention' })])
  })
})
