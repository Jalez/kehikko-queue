import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { Screen } from '../src/app.tsx'
import {
  AXES_HEIGHT,
  PAD_X,
  PAD_Y,
  SPARK_HEIGHT,
  TIP_LINE_MAX,
  atLeast,
  clip,
  clock,
  columnHeight,
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
  tipLines,
  tipSide,
  type Tip,
} from '../src/glance.ts'
import type { Api, Machine, Overview } from '../src/wire/api.ts'
import type { Host } from '../src/wire/use-kehikot.ts'
import { TOUCH_MS, resetTips } from '../src/lib/one-tip.ts'
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
    expect(resultsSaid(results)).toBe('The last 3: 2 passed, 1 failed. Latest: “red first” (push) passed.')
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
        'The last 3: 2 passed, 1 failed. Latest: “red first” (push) passed.',
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
 * The tiles in one narrow column (Test runs 0.9.0, tidied in 0.9.1): no cards, a hairline between
 * tiles, title, words and number on one row in one column with the plot edge to edge under it,
 * sparklines under 260 px and axes from there, and a solid tooltip of three short lines outside the
 * plot — by pointer, finger or keyboard.
 */

describe('the tiles\' layout at each width', () => {
  test('one column of sparklines under 260 px, axes and a taller plot from there, three columns of sparklines from 360', () => {
    expect(tileLayout(200)).toEqual({ columns: 1, tile: 200, axes: false, plot: SPARK_HEIGHT, compact: true })
    expect(tileLayout(240)).toEqual({ columns: 1, tile: 240, axes: false, plot: SPARK_HEIGHT, compact: true })
    expect(tileLayout(280)).toEqual({ columns: 1, tile: 280, axes: true, plot: AXES_HEIGHT, compact: true })
    expect(tileLayout(320)).toEqual({ columns: 1, tile: 320, axes: true, plot: AXES_HEIGHT, compact: true })
    /* Three columns, 1 px apart. */
    expect(tileLayout(400)).toEqual({ columns: 3, tile: 132, axes: false, plot: SPARK_HEIGHT, compact: false })
    expect(tileLayout(null)).toEqual({ columns: 1, tile: null, axes: false, plot: SPARK_HEIGHT, compact: true })
  })
  test('one column stands no taller than it needs: 236 px at 240 (it was 322 with cards and gaps)', () => {
    /* Three rows of 6 + 20 + 2 + 44 + 6, and two hairlines. */
    expect(columnHeight(tileLayout(240))).toBe(236)
    expect(columnHeight(tileLayout(200))).toBe(236)
    expect(columnHeight(tileLayout(280))).toBe(3 * (6 + 20 + 2 + 72 + 6) + 2)
  })
  test('a pointer picks the nearest point of a line and the bar it is over, inside the plot', () => {
    expect(indexAt(95, 200, 6, 'line')).toBe(2)
    expect(indexAt(500, 200, 6, 'line')).toBe(5)
    expect(indexAt(120, 200, 4, 'bar')).toBe(2)
    expect(indexAt(-3, 200, 4, 'bar')).toBe(0)
    expect(indexAt(10, 0, 4, 'bar')).toBeNull()
  })
  test('the tooltip sits outside the plot: above when it fits, else below', () => {
    expect(tipSide(80, 60)).toBe('above')
    expect(tipSide(30, 60)).toBe('below')
    expect(tipSide(0, 0)).toBe('below')
  })
  test('the tooltip leans away from the edge; the keys move along it; an axis top is round', () => {
    expect([tipAlign(0, 6), tipAlign(3, 6), tipAlign(5, 6)]).toEqual(['start', 'center', 'end'])
    expect([stepped('ArrowLeft', null, 6), stepped('ArrowLeft', 3, 6), stepped('ArrowRight', 5, 6), stepped('Home', 3, 6), stepped('End', 0, 6), stepped('Escape', 2, 6), stepped('x', 2, 6)]).toEqual([5, 2, 5, 0, 5, null, undefined])
    expect([niceTop(2), niceTop(9.9), niceTop(0)]).toEqual([2, 10, 1])
  })
})

describe('what each tooltip says', () => {
  test('the queue: running of the most at once, and whether more could start', () => {
    expect(queueTip({ at: 60_000, running: 1 }, 2)).toEqual({ value: '1 / 2 running', detail: '1 more can start', note: clock(60_000) })
    expect(queueTip({ at: 60_000, running: 2 }, 2).detail).toBe('Full: new runs wait')
  })
  test('the load against the limit above which new runs wait', () => {
    expect(loadTip({ at: 60_000, load: 3.2 }, machine)).toEqual({ value: 'Load 3.2', detail: 'Runs wait above 9.0', note: clock(60_000) })
    expect(loadTip({ at: 60_000, load: 9.5 }, machine).detail).toBe('Holding new runs')
  })
  test('a result: how it came out and how long it ran, which run, and when it ended', () => {
    expect(resultTip({ id: 'p1', label: 'lint', state: 'passed', seconds: 75, at: 3500 })).toEqual({ value: 'Passed in 1 min 15 s', detail: 'lint', note: clock(3500) })
    expect(resultTip({ id: 'c1', label: 'x', state: 'cancelled', seconds: 0, at: 0 })).toEqual({ value: 'Cancelled before start', detail: 'x', note: '' })
  })
  test('every tooltip is three short lines at most, however large the figures and long the labels', () => {
    const tips: Tip[] = [
      queueTip({ at: 60_000, running: 12 }, 12),
      queueTip({ at: 60_000, running: 0 }, 128),
      loadTip({ at: 60_000, load: 123.45 }, { loadAbove: 99.9 }),
      loadTip({ at: 60_000, load: 0 }, { loadAbove: 99.9 }),
      resultTip({ id: 'l', label: 'kehikko-monitor tidy-tiles verify suite, the whole of it', state: 'failed', seconds: 3 * 3600 + 59 * 60, at: 3500 }),
      resultTip({ id: 'm', label: 'unit', state: 'cancelled', seconds: 59 * 60 + 59, at: 3500 }),
    ]
    for (const one of tips) {
      const lines = tipLines(one)
      expect(lines.length).toBeGreaterThan(0)
      expect(lines.length).toBeLessThanOrEqual(3)
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(TIP_LINE_MAX)
    }
    expect(clip('A'.repeat(40))).toHaveLength(TIP_LINE_MAX)
  })
})

describe('the tiles drawn at each width', () => {
  for (const [width, axes, height] of [
    [200, false, SPARK_HEIGHT],
    [240, false, SPARK_HEIGHT],
    [280, true, AXES_HEIGHT],
    [320, true, AXES_HEIGHT],
  ] as const) {
    test(`${width} px: title, words and number on one row, then a plot ${height} px tall edge to edge${axes ? ', with axes' : ', a sparkline'}`, async () => {
      const { api } = fakeApi(RUNS)
      render(<Screen host={host()} api={api} now={() => 5000} box={{ width, height: 600 }} />)
      await settle()
      expect(screen.getByTestId('glance').getAttribute('data-axes')).toBe(String(axes))
      expect(screen.getByTestId('glance').getAttribute('data-compact')).toBe('true')
      for (const id of ['tile-queue', 'tile-load', 'tile-results']) {
        const [head, plot, more] = [...screen.getByTestId(id).children] as HTMLElement[]
        expect(head?.getAttribute('data-testid')).toBe(`${id}-head`)
        const [title, sub, value] = [...head!.children] as HTMLElement[]
        expect(title?.tagName).toBe('H2')
        expect(sub?.className).toContain('truncate')
        expect(sub?.getAttribute('title')).toBe(sub?.textContent ?? '')
        expect(value?.getAttribute('data-testid')).toBe(`${id}-value`)
        expect(plot?.getAttribute('data-testid')).toBe(`${id}-plot`)
        expect(plot?.style.height).toBe(`${height}px`)
        expect(plot?.style.marginInline).toBe(`-${PAD_X}px`)
        expect(more).toBeUndefined()
      }
    })
  }

  test('no cards: no border, background card or gap of a tile’s own, a hairline between, tight padding; side by side the words go under the title', async () => {
    const { api } = fakeApi(RUNS)
    const one = render(<Screen host={host()} api={api} now={() => 5000} box={{ width: 240, height: 600 }} />)
    await settle()
    const glance = screen.getByTestId('glance')
    expect(glance.className).toContain('gap-px')
    expect(glance.className).toContain('bg-border')
    for (const tile of [...glance.children] as HTMLElement[]) {
      expect(tile.className).not.toMatch(/\bborder\b|bg-card|rounded/)
      expect(tile.className).toContain('bg-background')
      expect(tile.style.padding).toBe(`${PAD_Y}px ${PAD_X}px`)
    }
    one.unmount()
    render(<Screen host={host()} api={api} now={() => 5000} box={{ width: 700, height: 700 }} />)
    await settle()
    expect(screen.getByTestId('glance').getAttribute('data-compact')).toBe('false')
    const [head, sub, plot] = [...screen.getByTestId('tile-queue').children] as HTMLElement[]
    expect(head?.getAttribute('data-testid')).toBe('tile-queue-head')
    expect(sub?.className).toContain('truncate')
    expect(plot?.getAttribute('data-testid')).toBe('tile-queue-plot')
  })

  test('Tab to a chart shows its latest point; the arrows move along; Escape and leaving close it', async () => {
    const { api } = fakeApi(RUNS)
    render(<Screen host={host()} api={api} now={() => 5000} box={{ width: 240, height: 600 }} />)
    await settle()
    const plot = (id: string) => within(screen.getByTestId(`${id}-plot`)).getByRole('img')
    const tip = (id: string) => screen.getByTestId(`${id}-tip`)
    const queue = plot('tile-queue')
    expect(queue.tabIndex).toBe(0)
    expect(tip('tile-queue').textContent).toBe('')
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(queue)
    expect(tip('tile-queue').textContent).toBe(`1 / 2 running1 more can start${clock(5000)}`)
    /* Solid, 12 px, a strong border and a shadow, wrapped within a width, outside the plot. */
    const shown = tip('tile-queue')
    for (const one of ['bg-popover', 'text-xs', 'border-foreground/25', 'shadow-lg', 'break-words', 'max-w-[min(15rem,calc(100%-8px))]']) expect(shown.className).toContain(one)
    /* Never see-through: no opacity, no popover colour with an alpha. */
    expect(shown.className).not.toMatch(/opacity|bg-popover\//)
    expect(shown.getAttribute('data-side')).toBe('below')
    expect(shown.style.top).toBe('calc(100% + 4px)')
    expect((shown.firstElementChild as HTMLElement).className).toContain('font-semibold')
    expect(shown.children).toHaveLength(3)
    expect(queue.getAttribute('aria-describedby')).toBe(tip('tile-queue').id)
    expect(tip('tile-queue').getAttribute('aria-live')).toBe('polite')
    fireEvent.keyDown(queue, { key: 'Escape' })
    expect(tip('tile-queue').textContent).toBe('')
    fireEvent.focus(plot('tile-load'))
    expect(tip('tile-load').textContent).toBe(`Load 2.4Runs wait above 9.0${clock(120_000)}`)
    fireEvent.keyDown(plot('tile-load'), { key: 'ArrowLeft' })
    expect(tip('tile-load').textContent).toContain('Load 3.2')
    fireEvent.focus(plot('tile-results'))
    fireEvent.keyDown(plot('tile-results'), { key: 'Home' })
    expect(tip('tile-results').textContent).toBe(`Failed in 2 sbrokenPush · ${clock(3000)}`)
    fireEvent.blur(plot('tile-results'))
    expect(tip('tile-results').textContent).toBe('')
  })
})

describe('one chart tooltip, and only while it is wanted (Test runs 0.9.2)', () => {
  beforeEach(resetTips)

  const draw = async () => {
    const { api } = fakeApi(RUNS)
    render(<Screen host={host()} api={api} now={() => 5000} box={{ width: 240, height: 600 }} />)
    await settle()
  }
  const plotOf = (id: string) => {
    const el = within(screen.getByTestId(`${id}-plot`)).getByRole('img')
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => ({}) })
    return el
  }
  const tip = (id: string) => screen.getByTestId(`${id}-tip`).textContent
  const hover = (el: HTMLElement) => fireEvent.pointerMove(el, { pointerType: 'mouse', clientX: 100, clientY: 20 })

  test('leaving the plot hides it', async () => {
    await draw()
    const queue = plotOf('tile-queue')
    hover(queue)
    expect(tip('tile-queue')).not.toBe('')
    fireEvent.pointerLeave(queue, { pointerType: 'mouse' })
    expect(tip('tile-queue')).toBe('')
  })

  test('the pointer leaving the page (the module) hides it', async () => {
    await draw()
    const queue = plotOf('tile-queue')
    hover(queue)
    act(() => void document.documentElement.dispatchEvent(new MouseEvent('mouseleave')))
    expect(tip('tile-queue')).toBe('')
    hover(queue)
    expect(tip('tile-queue')).not.toBe('')
    act(() => void document.dispatchEvent(new PointerEvent('pointerout', { pointerType: 'mouse', relatedTarget: null })))
    expect(tip('tile-queue')).toBe('')
  })

  test('the window losing focus, the page hidden, a scroll, a resize and Escape each hide it', async () => {
    await draw()
    const queue = plotOf('tile-queue')
    const aways = [
      () => window.dispatchEvent(new Event('blur')),
      () => window.dispatchEvent(new Event('scroll')),
      () => window.dispatchEvent(new Event('resize')),
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    ]
    for (const away of aways) {
      hover(queue)
      expect(tip('tile-queue')).not.toBe('')
      act(() => void away())
      expect(tip('tile-queue')).toBe('')
    }
  })

  test('showing a second hides the first: never every chart at once', async () => {
    await draw()
    hover(plotOf('tile-queue'))
    hover(plotOf('tile-load'))
    hover(plotOf('tile-results'))
    expect(tip('tile-results')).not.toBe('')
    expect(tip('tile-queue')).toBe('')
    expect(tip('tile-load')).toBe('')
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(plotOf('tile-load'))
    fireEvent.focus(plotOf('tile-queue'))
    expect(tip('tile-load')).toBe('')
    expect(tip('tile-results')).toBe('')
    expect(tip('tile-queue')).not.toBe('')
  })

  test('a click that focuses a chart leaves no tooltip once the pointer goes', async () => {
    await draw()
    const queue = plotOf('tile-queue')
    fireEvent.pointerDown(queue, { pointerType: 'mouse', clientX: 100, clientY: 20 })
    fireEvent.focus(queue)
    expect(tip('tile-queue')).not.toBe('')
    fireEvent.pointerLeave(queue, { pointerType: 'mouse' })
    expect(tip('tile-queue')).toBe('')
    fireEvent.blur(queue)
    fireEvent.focus(queue)
    expect(tip('tile-queue')).toBe('')
  })

  test('keyboard focus still shows it, and blur hides it', async () => {
    await draw()
    const queue = plotOf('tile-queue')
    fireEvent.pointerDown(document.body, { pointerType: 'mouse' })
    fireEvent.keyDown(document.body, { key: 'Tab' })
    fireEvent.focus(queue)
    expect(tip('tile-queue')).toBe(`1 / 2 running1 more can start${clock(5000)}`)
    fireEvent.blur(queue)
    expect(tip('tile-queue')).toBe('')
  })

  test('a tap shows it; a tap elsewhere or the time hides it', async () => {
    await draw()
    jest.useFakeTimers()
    try {
      const queue = plotOf('tile-queue')
      fireEvent.pointerDown(queue, { pointerType: 'touch', clientX: 100, clientY: 20 })
      fireEvent.pointerLeave(queue, { pointerType: 'touch' })
      expect(tip('tile-queue')).not.toBe('')
      fireEvent.pointerDown(document.body, { pointerType: 'touch' })
      expect(tip('tile-queue')).toBe('')
      fireEvent.pointerDown(queue, { pointerType: 'touch', clientX: 100, clientY: 20 })
      expect(tip('tile-queue')).not.toBe('')
      act(() => void jest.advanceTimersByTime(TOUCH_MS + 1))
      expect(tip('tile-queue')).toBe('')
    } finally {
      jest.useRealTimers()
    }
  })
})
