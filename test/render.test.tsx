import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { Screen } from '../src/app.tsx'
import { streams } from './streams.ts'
import type { Api, Overview } from '../src/wire/api.ts'
import type { Host } from '../src/wire/use-kehikot.ts'
import { aRun } from './inbox.test.ts'

afterEach(cleanup)

const host = (over: Partial<Host> = {}): Host => ({
  where: 'hosted',
  project: 'p',
  projectPath: '/p',
  projectId: null,
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
    ...streams().api,
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
    release: async (id) => {
      said.push(`release ${id}`)
      return { runs, machine }
    },
  }
  return { api, said }
}

const settle = () => act(async () => {
  await new Promise((done) => setTimeout(done, 20))
})

describe('the Queue page', () => {
  test('says ready once the queue is drawn, hidden or not, and marks the scroller the kept view reads (protocol 2.70.0)', async () => {
    let readied = 0
    let answer: (overview: Overview) => void = () => {}
    const api: Api = { ...fakeApi([]).api, runs: () => new Promise((done) => (answer = done)) }
    render(<Screen host={host({ visible: false, ready: () => void readied++ })} api={api} now={() => 5000} />)
    await settle()
    expect(readied).toBe(0)
    await act(async () => answer({ runs: [aRun({ id: 'p1', state: 'passed', exit: 0 })], machine }))
    await settle()
    expect(readied).toBe(1)
    expect(document.querySelector('main[data-kehikot-scroll]')).not.toBeNull()
  })

  test('says ready when the queue could not be read, too', async () => {
    let readied = 0
    const api: Api = { ...fakeApi([]).api, runs: async () => Promise.reject(new Error('Queue did not answer.')) }
    render(<Screen host={host({ ready: () => void readied++ })} api={api} now={() => 5000} />)
    await settle()
    expect(readied).toBe(1)
  })

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

  test('reports every run of the last day to the Inbox quietly: a failure is done, never needing the person', async () => {
    const reported: unknown[] = []
    const { api } = fakeApi([aRun()])
    render(<Screen host={host({ activity: (items) => reported.push(items) })} api={api} now={() => 5000} />)
    await settle()
    expect(reported.at(-1)).toEqual([expect.objectContaining({ id: 'run:r1', state: 'done', priority: 'low' })])
  })
})

describe('the page is told, never asks on a clock', () => {
  test('the queue and a running run’s output are read as their streams open and on news, with no timer of the page’s own', async () => {
    const runs = [aRun({ id: 'u1', state: 'running', finishedAt: null, exit: null, label: 'unit' }), aRun({ id: 'w1', state: 'queued', startedAt: null, finishedAt: null, exit: null, position: 1 })]
    const told = streams()
    const reads = { runs: 0, output: [] as number[] }
    let size = 4
    const api: Api = {
      ...told.api,
      runs: async () => (reads.runs++, { runs, machine }),
      output: async (_id, from) => {
        reads.output.push(from)
        return { text: 'x'.repeat(Math.max(0, size - from)), next: size, size }
      },
      cancel: async () => ({ runs, machine }),
      move: async () => ({ runs, machine }),
      release: async () => ({ runs, machine }),
    }
    const realInterval = globalThis.setInterval
    let intervals = 0
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => (intervals++, realInterval(...args))) as typeof setInterval
    try {
      render(<Screen host={host()} api={api} now={() => 5000} />)
      await settle()
      expect(reads.runs).toBe(1)
      fireEvent.click(screen.getByRole('button', { name: 'Output of “unit”' }))
      await settle()
      expect(reads.output).toEqual([0])
      /* Longer than either old poll would have waited (1 s for the output, 2 s for a busy queue). */
      await act(async () => void (await new Promise((done) => setTimeout(done, 2100))))
      expect(reads.runs).toBe(1)
      expect(reads.output).toEqual([0])
      expect(intervals).toBe(0)

      /* The run's log grew: one read, from where the last one ended. */
      size = 10
      await act(async () => told.tellOutput('u1'))
      await settle()
      expect(reads.output).toEqual([0, 4])
      expect(screen.getByTestId('output').textContent).toBe('x'.repeat(10))

      /* The queue changed (queue_run, queue_cancel, a run finishing): one read. */
      await act(async () => told.tell())
      await settle()
      expect(reads.runs).toBe(2)
      expect(intervals).toBe(0)

      cleanup()
      expect(told.open.runs.length).toBe(0)
      expect(told.open.output.get('u1')?.length ?? 0).toBe(0)
    } finally {
      globalThis.setInterval = realInterval
    }
  })
})

describe('opening a run', () => {
  test('opened from the Inbox: that run is highlighted, scrolled to and its output opened, and nothing is sent', async () => {
    const runs = [aRun({ id: 'f1', label: 'unit' }), aRun({ id: 'f2', label: 'other' })]
    const { api, said } = fakeApi(runs)
    const scrolled: string[] = []
    const real = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset.run ?? '')
    }
    try {
      const { rerender } = render(<Screen host={host()} api={api} now={() => 5000} openedItem={{ item: 'run:f2', n: 1 }} />)
      await settle()
      expect((document.querySelector('li[data-run="f2"]') as HTMLElement).dataset.focused).toBe('true')
      expect((document.querySelector('li[data-run="f1"]') as HTMLElement).dataset.focused).toBeUndefined()
      expect(scrolled).toEqual(['f2'])
      expect(screen.getByTestId('drawer').getAttribute('data-run')).toBe('f2')
      expect(said).toEqual([])
      /* The same open again is not handled twice; an item of a run that has gone is ignored. */
      rerender(<Screen host={host()} api={api} now={() => 5000} openedItem={{ item: 'run:f2', n: 1 }} />)
      rerender(<Screen host={host()} api={api} now={() => 5000} openedItem={{ item: 'run:gone', n: 2 }} />)
      await settle()
      expect(scrolled).toEqual(['f2'])
      expect(said).toEqual([])
    } finally {
      HTMLElement.prototype.scrollIntoView = real
    }
  })
})

