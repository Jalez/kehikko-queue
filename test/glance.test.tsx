import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { Screen } from '../src/app.tsx'
import {
  AXES_HEIGHT,
  SPARK_HEIGHT,
  atLeast,
  clock,
  indexAt,
  levelOf,
  loadTip,
  niceTop,
  queueNow,
  queueSaid,
  queueTip,
  recentResults,
  resultTip,
  resultsSaid,
  runningOver,
  stepped,
  strainSaid,
  tileLayout,
  tipAlign,
} from '../src/glance.ts'
import type { Api, Machine, Overview } from '../src/wire/api.ts'
import type { Host } from '../src/wire/use-kehikot.ts'
import { aRun } from './inbox.test.ts'
import { streams } from './streams.ts'

/*
 * The page at a glance (issue #19): in a small container only the queue, the strain and the recent
 * results; each run and its details as the container grows; never "needs your attention".
 */

afterEach(cleanup)

const machine: Machine = { cores: 12, load: 3.2, most: 2, loadAbove: 9, waitMinutes: 10, samples: [{ at: 0, load: 1.5 }, { at: 60_000, load: 3.2 }, { at: 120_000, load: 2.4 }] }
const settle = () => act(async () => void (await new Promise((done) => setTimeout(done, 20))))

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

function fakeApi(runs: Overview['runs'], at: Machine = machine) {
  const said: string[] = []
  const api: Api = {
    ...streams().api,
    runs: async () => ({ runs, machine: at }),
    output: async (id) => ({ text: `output of ${id}`, next: 10, size: 10 }),
    cancel: async (id) => (said.push(`cancel ${id}`), { runs, machine: at }),
    move: async (id, to) => (said.push(`move ${id} ${to}`), { runs, machine: at }),
  }
  return { api, said }
}

const RUNS = [
  aRun({ id: 'w1', label: 'waiting one', state: 'queued', startedAt: null, finishedAt: null, exit: null, position: 1, waiting: 'Next: waiting for one of the 2 running to finish.' }),
  aRun({ id: 'u1', label: 'unit', state: 'running', startedAt: 4000, finishedAt: null, exit: null }),
  aRun({ id: 'f1', label: 'broken', state: 'failed', startedAt: 1000, finishedAt: 3000 }),
  aRun({ id: 'p1', label: 'lint', state: 'passed', exit: 0, startedAt: 2000, finishedAt: 3500 }),
  aRun({ id: 'e1', label: 'red first', state: 'passed', exit: 0, expect: 'fail', startedAt: 2000, finishedAt: 3600 }),
]

describe('levels, from the container\'s own size', () => {
  test('a short container is a glance; narrow or short a list; then rows; roomy is full; unmeasured is full', () => {
    expect(levelOf({ width: 380, height: 200 })).toBe('glance')
    expect(levelOf({ width: 200, height: 600 })).toBe('list')
    expect(levelOf({ width: 280, height: 600 })).toBe('list')
    expect(levelOf({ width: 380, height: 300 })).toBe('list')
    expect(levelOf({ width: 380, height: 450 })).toBe('rows')
    expect(levelOf({ width: 700, height: 700 })).toBe('full')
    expect(levelOf(null)).toBe('full')
    expect(atLeast('rows', 'list')).toBe(true)
    expect(atLeast('glance', 'list')).toBe(false)
  })
})

describe('what a glance says', () => {
  test('the queue: running of the most at once, and waiting', () => {
    expect(queueSaid(queueNow(RUNS, machine))).toBe('1 of 2 running, 1 waiting.')
    expect(queueSaid({ running: 0, waiting: 0, most: 4 })).toBe('0 of 4 running, none waiting.')
  })
  test('how many ran at each moment of the window, the last one now', () => {
    const over = runningOver(RUNS, 5000, 4000, 4)
    expect(over.map((one) => one.running)).toEqual([1, 3, 2, 1, 1])
    expect(over.at(-1)!.at).toBe(5000)
  })
  test('the strain, with the samples\' range, and when it holds new runs', () => {
    expect(strainSaid(machine, machine.samples!)).toBe('Load 3.2 on 12 cores; new runs wait above 9.0. Over the last 2 min it went from 1.5 to 3.2.')
    expect(strainSaid({ ...machine, load: 9.5 }, [])).toBe('Load 9.5 on 12 cores; new runs wait above 9.0, so new runs are being held.')
  })
  test('the latest results, oldest first, with their counts and the latest one', () => {
    const results = recentResults(RUNS)
    expect(results.map((one) => [one.id, one.state, one.seconds])).toEqual([
      ['f1', 'failed', 2],
      ['p1', 'passed', 2],
      ['e1', 'passed', 2],
    ])
    expect(resultsSaid(results)).toBe('The last 3: 2 passed, 1 failed. Latest: “red first” passed.')
    expect(resultsSaid([])).toBe('No results yet.')
  })
})

describe('the page at each size', () => {
  for (const width of [200, 280, 380]) {
    test(`a short container ${width} px wide: the three tiles, each chart with its sentence, and no run rows`, async () => {
      const { api } = fakeApi(RUNS)
      render(<Screen host={host()} api={api} now={() => 5000} box={{ width, height: 200 }} />)
      await settle()
      expect(screen.getByTestId('tile-queue-value').textContent).toBe('1/2 running')
      expect(screen.getByTestId('tile-load-value').textContent).toBe('3.2 / 9.0')
      expect(screen.getByTestId('tile-results-value').textContent).toBe('2 passed')
      expect(within(screen.getByTestId('tile-results')).getByText('1 failed')).toBeTruthy()
      const pictures = screen.getAllByRole('img')
      expect(pictures.map((one) => one.getAttribute('aria-label'))).toEqual([
        '1 of 2 running, 1 waiting.',
        'Load 3.2 on 12 cores; new runs wait above 9.0. Over the last 2 min it went from 1.5 to 3.2.',
        'The last 3: 2 passed, 1 failed. Latest: “red first” passed.',
      ])
      expect(document.querySelectorAll('[data-run]')).toHaveLength(0)
      expect(screen.queryByTestId('machine')).toBeNull()
    })
  }

  test('a narrow container: one line per run, which opens its drawer; the drawer cancels a running run', async () => {
    const { api, said } = fakeApi(RUNS)
    render(<Screen host={host()} api={api} now={() => 5000} box={{ width: 280, height: 600 }} />)
    await settle()
    expect(document.querySelectorAll('[data-run]')).toHaveLength(5)
    /* No row buttons, no kind badge, no long sentences: the line and its drawer. */
    expect(screen.queryByRole('button', { name: /^Cancel/ })).toBeNull()
    expect(document.body.textContent).not.toContain('From pre-push hook')
    fireEvent.click(screen.getByRole('button', { name: '“unit”: Running. Details and output' }))
    await settle()
    const drawer = screen.getByTestId('drawer')
    expect(drawer.getAttribute('data-run')).toBe('u1')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel “unit”' }))
    await settle()
    expect(said).toEqual(['cancel u1'])
  })

  test('rows: buttons and output, one short line each; full: where it came from and the machine\'s limits', async () => {
    const { api } = fakeApi(RUNS)
    const rows = render(<Screen host={host()} api={api} now={() => 5000} box={{ width: 400, height: 450 }} />)
    await settle()
    expect(screen.getByRole('button', { name: 'Cancel “unit”' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Output of / })).toHaveLength(4)
    expect(document.body.textContent).not.toContain('From pre-push hook')
    expect(screen.queryByTestId('machine')).toBeNull()
    rows.unmount()
    render(<Screen host={host()} api={api} now={() => 5000} box={{ width: 700, height: 700 }} />)
    await settle()
    expect(document.body.textContent).toContain('From pre-push hook')
    expect(screen.getByTestId('machine')).toBeTruthy()
  })

  test('a load above the limit says it holds new runs, in words', async () => {
    const { api } = fakeApi(RUNS, { ...machine, load: 9.5 })
    render(<Screen host={host()} api={api} now={() => 5000} box={{ width: 200, height: 200 }} />)
    await settle()
    expect(within(screen.getByTestId('tile-load')).getByText('holding new runs')).toBeTruthy()
  })
})

describe('no result asks for the person', () => {
  test('a failure and a pass that was expected to fail have no border, no "needs your attention", no Mark as seen', async () => {
    const { api } = fakeApi(RUNS)
    render(<Screen host={host()} api={api} now={() => 5000} />)
    await settle()
    expect(document.body.textContent).not.toMatch(/needs? your attention|Mark (all )?(as )?seen/i)
    expect(screen.queryAllByRole('button', { name: /seen/i })).toHaveLength(0)
    expect(document.querySelector('[data-needs]')).toBeNull()
    expect(document.querySelector('.border-attention')).toBeNull()
    /* The page still says how each run came out. */
    const finished = screen.getByRole('region', { name: 'Finished' })
    expect(finished.textContent).toContain('Failed (exit 3)')
    expect(finished.textContent).toContain('expected to fail')
  })
})

/*
 * The tiles in one narrow column (Test runs 0.9.0): title and number in a row of their own above the
 * plot, sparklines under 260 px and axes from there, and a tooltip that says the value against its
 * limit and when — by pointer, finger or keyboard.
 */

describe('the tiles\' layout at each width', () => {
  test('one column of sparklines under 260 px, axes and a taller plot from there, three columns of sparklines from 360', () => {
    expect(tileLayout(200)).toEqual({ columns: 1, tile: 200, axes: false, plot: SPARK_HEIGHT })
    expect(tileLayout(240)).toEqual({ columns: 1, tile: 240, axes: false, plot: SPARK_HEIGHT })
    expect(tileLayout(280)).toEqual({ columns: 1, tile: 280, axes: true, plot: AXES_HEIGHT })
    expect(tileLayout(320)).toEqual({ columns: 1, tile: 320, axes: true, plot: AXES_HEIGHT })
    expect(tileLayout(400)).toEqual({ columns: 3, tile: 128, axes: false, plot: SPARK_HEIGHT })
    expect(tileLayout(null)).toEqual({ columns: 1, tile: null, axes: false, plot: SPARK_HEIGHT })
  })
  test('a pointer picks the nearest point of a line and the bar it is over, inside the plot', () => {
    expect(indexAt(95, 200, 6, 'line')).toBe(2)
    expect(indexAt(500, 200, 6, 'line')).toBe(5)
    expect(indexAt(120, 200, 4, 'bar')).toBe(2)
    expect(indexAt(-3, 200, 4, 'bar')).toBe(0)
    expect(indexAt(10, 0, 4, 'bar')).toBeNull()
  })
  test('the tooltip leans away from the edge; the keys move along it; an axis top is round', () => {
    expect([tipAlign(0, 6), tipAlign(3, 6), tipAlign(5, 6)]).toEqual(['start', 'center', 'end'])
    expect([stepped('ArrowLeft', null, 6), stepped('ArrowLeft', 3, 6), stepped('ArrowRight', 5, 6), stepped('Home', 3, 6), stepped('End', 0, 6), stepped('Escape', 2, 6), stepped('x', 2, 6)]).toEqual([5, 2, 5, 0, 5, null, undefined])
    expect([niceTop(2), niceTop(9.9), niceTop(0)]).toEqual([2, 10, 1])
  })
})

describe('what each tooltip says', () => {
  test('the queue: running of the most at once, and whether more could start', () => {
    expect(queueTip({ at: 60_000, running: 1 }, 2)).toEqual({ value: '1/2 running', detail: '1 more could start', at: clock(60_000) })
    expect(queueTip({ at: 60_000, running: 2 }, 2).detail).toBe('full: new runs wait')
  })
  test('the load against the limit above which new runs wait', () => {
    expect(loadTip({ at: 60_000, load: 3.2 }, machine)).toEqual({ value: '3.2 / 9.0 load', detail: 'new runs wait above 9.0 · 12 cores', at: clock(60_000) })
    expect(loadTip({ at: 60_000, load: 9.5 }, machine).detail).toBe('holding new runs · 12 cores')
  })
  test('a result: its label and how it came out, how long it ran and when it ended', () => {
    expect(resultTip({ id: 'p1', label: 'lint', state: 'passed', seconds: 75, at: 3500 })).toEqual({ value: '“lint” passed', detail: 'ran 1 min 15 s', at: clock(3500) })
    expect(resultTip({ id: 'c1', label: 'x', state: 'cancelled', seconds: 0, at: 0 })).toEqual({ value: '“x” cancelled', detail: 'did not start', at: '' })
  })
})

describe('the tiles drawn at each width', () => {
  for (const [width, axes, height] of [
    [200, false, SPARK_HEIGHT],
    [240, false, SPARK_HEIGHT],
    [280, true, AXES_HEIGHT],
    [320, true, AXES_HEIGHT],
  ] as const) {
    test(`${width} px: title and number in their own row above a plot ${height} px tall${axes ? ', with axes' : ', a sparkline'}`, async () => {
      const { api } = fakeApi(RUNS)
      render(<Screen host={host()} api={api} now={() => 5000} box={{ width, height: 600 }} />)
      await settle()
      expect(screen.getByTestId('glance').getAttribute('data-axes')).toBe(String(axes))
      for (const id of ['tile-queue', 'tile-load', 'tile-results']) {
        const [head, sub, plot] = [...screen.getByTestId(id).children] as HTMLElement[]
        expect(head?.getAttribute('data-testid')).toBe(`${id}-head`)
        expect(within(head!).getByRole('heading')).toBeTruthy()
        expect(sub?.className).toContain('truncate')
        expect(sub?.getAttribute('title')).toBe(sub?.textContent ?? '')
        expect(plot?.getAttribute('data-testid')).toBe(`${id}-plot`)
        expect(plot?.style.height).toBe(`${height}px`)
      }
    })
  }

  test('Tab to a chart shows its latest point; the arrows move along; Escape and leaving close it', async () => {
    const { api } = fakeApi(RUNS)
    render(<Screen host={host()} api={api} now={() => 5000} box={{ width: 240, height: 600 }} />)
    await settle()
    const plot = (id: string) => within(screen.getByTestId(`${id}-plot`)).getByRole('img')
    const tip = (id: string) => screen.getByTestId(`${id}-tip`)
    const queue = plot('tile-queue')
    expect(queue.tabIndex).toBe(0)
    expect(tip('tile-queue').textContent).toBe('')
    fireEvent.focus(queue)
    expect(tip('tile-queue').textContent).toBe(`1/2 running${clock(5000)}1 more could start`)
    expect(queue.getAttribute('aria-describedby')).toBe(tip('tile-queue').id)
    expect(tip('tile-queue').getAttribute('aria-live')).toBe('polite')
    fireEvent.keyDown(queue, { key: 'Escape' })
    expect(tip('tile-queue').textContent).toBe('')
    fireEvent.focus(plot('tile-load'))
    expect(tip('tile-load').textContent).toBe(`2.4 / 9.0 load${clock(120_000)}new runs wait above 9.0 · 12 cores`)
    fireEvent.keyDown(plot('tile-load'), { key: 'ArrowLeft' })
    expect(tip('tile-load').textContent).toContain('3.2 / 9.0 load')
    fireEvent.focus(plot('tile-results'))
    fireEvent.keyDown(plot('tile-results'), { key: 'Home' })
    expect(tip('tile-results').textContent).toBe(`“broken” failed${clock(3000)}ran 2 s`)
    fireEvent.blur(plot('tile-results'))
    expect(tip('tile-results').textContent).toBe('')
  })
})
