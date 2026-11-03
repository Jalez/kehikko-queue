import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { Screen } from '../src/app.tsx'
import { streams } from './streams.ts'
import type { Api, Overview } from '../src/wire/api.ts'
import type { Host } from '../src/wire/use-kehikot.ts'
import { aRun } from './inbox.test.ts'
import type { Observe } from '../src/in-view.ts'

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
    seen: async (id, marked) => {
      said.push(`seen ${id}${marked ? " marked" : ""}`)
      return { runs, machine }
    },
    seenAll: async (project) => {
      said.push(`seen-all ${project ?? "every project"}`)
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
      seen: async () => ({ runs, machine }),
      seenAll: async () => ({ runs, machine }),
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

describe('a failure that needs the person', () => {
  test('has a border AND the words, until its output is opened; then it is told seen once', async () => {
    const runs = [aRun({ id: 'f1', label: 'unit' }), aRun({ id: 'f2', label: 'old', seenAt: 4000 }), aRun({ id: 'p1', state: 'passed', exit: 0, label: 'lint' })]
    const { api, said } = fakeApi(runs)
    render(<Screen host={host()} api={api} now={() => 5000} />)
    await settle()
    const row = (id: string) => document.querySelector(`li[data-run="${id}"]`) as HTMLElement
    expect(row('f1').dataset.needs).toBe('true')
    expect(row('f1').className).toContain('border-attention')
    expect(row('f1').textContent).toContain('Needs your attention')
    /* Seen before, and a pass: no border, no words. */
    for (const id of ['f2', 'p1']) {
      expect(row(id).dataset.needs).toBeUndefined()
      expect(row(id).className).not.toContain('border-attention')
      expect(row(id).textContent).not.toContain('Needs your attention')
    }
    expect(screen.getAllByTestId('needs')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Output of “unit”' }))
    await settle()
    expect(said).toEqual(['seen f1'])
    /* Opening a run already seen, or a pass, tells nothing. */
    fireEvent.keyDown(screen.getByTestId('drawer'), { key: 'Escape' })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Output of “lint”' }))
    await settle()
    expect(said).toEqual(['seen f1'])
  })

  test('the border goes once the queue says the run was seen', async () => {
    let runs = [aRun({ id: 'f1', label: 'unit' })]
    const told = streams()
    const api: Api = { ...told.api, runs: async () => ({ runs, machine }), output: async () => ({ text: '', next: 0, size: 0 }), cancel: async () => ({ runs, machine }), move: async () => ({ runs, machine }), seen: async () => ({ runs, machine }), seenAll: async () => ({ runs, machine }) }
    render(<Screen host={host()} api={api} now={() => 5000} />)
    await settle()
    expect(screen.queryAllByTestId('needs')).toHaveLength(1)
    runs = [aRun({ id: 'f1', label: 'unit', seenAt: 4500 })]
    told.tell()
    await settle()
    expect(screen.queryAllByTestId('needs')).toHaveLength(0)
    expect((document.querySelector('li[data-run="f1"]') as HTMLElement).className).not.toContain('border-attention')
  })

  test('opened from the Inbox: that run is highlighted, scrolled to and its output opened, and it is told seen', async () => {
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
      expect(said).toEqual(['seen f2'])
      /* The same open again is not handled twice; an item of a run that has gone is ignored. */
      rerender(<Screen host={host()} api={api} now={() => 5000} openedItem={{ item: 'run:f2', n: 1 }} />)
      rerender(<Screen host={host()} api={api} now={() => 5000} openedItem={{ item: 'run:gone', n: 2 }} />)
      await settle()
      expect(scrolled).toEqual(['f2'])
      expect(said).toEqual(['seen f2'])
    } finally {
      HTMLElement.prototype.scrollIntoView = real
    }
  })
})

describe('clearing what asks for the person, on the page', () => {
  const row = (id: string) => document.querySelector(`li[data-run="${id}"]`) as HTMLElement

  test('Mark as seen on a failure that asks, and on nothing else', async () => {
    const runs = [aRun({ id: 'f1', label: 'unit' }), aRun({ id: 'f2', label: 'old', seenAt: 4000 }), aRun({ id: 'p1', state: 'passed', exit: 0, label: 'lint' }), aRun({ id: 'e1', label: 'red first', expect: 'fail' })]
    const { api, said } = fakeApi(runs)
    render(<Screen host={host()} api={api} now={() => 5000} />)
    await settle()
    expect(screen.getAllByRole('button', { name: /^Mark “.*” as seen$/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Mark “unit” as seen' }))
    await settle()
    expect(said).toEqual(['seen f1 marked'])
    /* One asking: no Mark all seen, the row's own is enough. */
    expect(screen.queryByRole('button', { name: 'Mark all seen' })).toBeNull()
  })

  test('an expected red has no border and says it failed as expected; an expected red that passed asks', async () => {
    const runs = [aRun({ id: 'e1', label: 'red first', expect: 'fail' }), aRun({ id: 'e2', label: 'red too', expect: 'fail', state: 'passed', exit: 0 })]
    const { api } = fakeApi(runs)
    render(<Screen host={host()} api={api} now={() => 5000} />)
    await settle()
    expect(row('e1').className).not.toContain('border-attention')
    expect(row('e1').textContent).toContain('failed as expected')
    expect(row('e2').className).toContain('border-attention')
    expect(row('e2').textContent).toContain('Needs your attention: it was expected to fail but passed')
  })

  test('Mark all seen: the open project\'s at This project, every one at This computer', async () => {
    const runs = [aRun({ id: 'f1', label: 'a' }), aRun({ id: 'f2', label: 'b' }), aRun({ id: 'f3', label: 'c', project: '/other' })]
    const { api, said } = fakeApi(runs)
    const here = render(<Screen host={host()} api={api} showing="here" now={() => 5000} />)
    await settle()
    expect(screen.getByTestId('asking').textContent).toContain('2 runs need your attention.')
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }))
    await settle()
    here.unmount()
    render(<Screen host={host()} api={api} showing="all" now={() => 5000} />)
    await settle()
    expect(screen.getByTestId('asking').textContent).toContain('3 runs need your attention.')
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }))
    await settle()
    expect(said).toEqual(['seen-all /p', 'seen-all every project'])
  })

  test('a superseded failure loses the border and says which run superseded it', async () => {
    const runs = [aRun({ id: 'f1', label: 'final', seenAt: 4000, supersededBy: 'p1' }), aRun({ id: 'p1', label: 'final (rerun)', state: 'passed', exit: 0 }), aRun({ id: 'f2', label: 'gone', seenAt: 4000, supersededBy: 'pruned' })]
    const { api } = fakeApi(runs)
    render(<Screen host={host()} api={api} now={() => 5000} />)
    await settle()
    expect(row('f1').className).not.toContain('border-attention')
    expect(row('f1').textContent).not.toContain('Needs your attention')
    expect(row('f1').textContent).toContain('Superseded by “final (rerun)”, which passed')
    expect(row('f2').textContent).toContain('Superseded by a later passing run of the same work.')
  })

  /** A watcher the test drives: which rows are watched, and a way to say one is in view or not. */
  function watcher() {
    const watched = new Map<string, (inView: boolean) => void>()
    const observe: Observe = (element, told) => {
      const id = (element as HTMLElement).dataset.run ?? ''
      watched.set(id, told)
      return () => watched.delete(id)
    }
    return { watched, observe }
  }

  test('a failure\'s row in view on a visible page for a moment counts as seen; leaving view first does not', async () => {
    const runs = [aRun({ id: 'f1', label: 'unit' }), aRun({ id: 'f2', label: 'other' }), aRun({ id: 'p1', state: 'passed', exit: 0 })]
    const { api, said } = fakeApi(runs)
    const { watched, observe } = watcher()
    render(<Screen host={host()} api={api} now={() => 5000} observe={observe} seenAfterMs={40} />)
    await settle()
    /* Only the rows that ask are watched: having the page open is not seeing them. */
    expect([...watched.keys()].sort()).toEqual(['f1', 'f2'])
    await settle()
    expect(said).toEqual([])
    act(() => watched.get('f2')!(true))
    await act(async () => new Promise((done) => setTimeout(done, 10)))
    act(() => watched.get('f2')!(false))
    act(() => watched.get('f1')!(true))
    await act(async () => new Promise((done) => setTimeout(done, 80)))
    expect(said).toEqual(['seen f1'])
  })

  test('nothing counts as seen while the host has the page hidden', async () => {
    const runs = [aRun({ id: 'f1', label: 'unit' })]
    const { api, said } = fakeApi(runs)
    const { watched, observe } = watcher()
    const { rerender } = render(<Screen host={host({ visible: false })} api={api} now={() => 5000} observe={observe} seenAfterMs={40} />)
    await settle()
    expect(watched.size).toBe(0)
    rerender(<Screen host={host({ visible: true })} api={api} now={() => 5000} observe={observe} seenAfterMs={40} />)
    await settle()
    act(() => watched.get('f1')!(true))
    rerender(<Screen host={host({ visible: false })} api={api} now={() => 5000} observe={observe} seenAfterMs={40} />)
    await act(async () => new Promise((done) => setTimeout(done, 80)))
    expect(said).toEqual([])
  })
})
