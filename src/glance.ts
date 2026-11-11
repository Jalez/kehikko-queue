import { kindSaid } from '../queue/kinds.ts'
import type { RunView } from '../queue/queue.ts'
import type { Machine, Sample } from './wire/api.ts'

/**
 * What the page shows at a glance, and how much more it shows as its container grows. Pure: the
 * page draws it, the tests read it.
 *
 * The container is the person's: a frame on a canvas is resized by them, not by the window, so the
 * page measures its own box (`useBox`) and picks a level from it:
 *
 * - `glance`  — under 240 px tall: the queue, the strain and the recent results, nothing else.
 * - `list`    — under 380 px wide or under 400 px tall: those, and one line per run (opens its drawer).
 * - `rows`    — each run's row with its kind, the jump into where it came from, its buttons and output.
 * - `full`    — 560 × 560 and more: each row says where it came from, how long it waited and ran, and
 *               why it ended, and the machine's limits are said in words.
 */

export type Level = 'glance' | 'list' | 'rows' | 'full'
export interface Box {
  width: number
  height: number
}

export function levelOf(box: Box | null): Level {
  /* Not measured yet (or nothing to measure with): everything, as before there were levels. */
  if (!box) return 'full'
  if (box.height < 240) return 'glance'
  if (box.width < 380 || box.height < 400) return 'list'
  if (box.width < 560 || box.height < 560) return 'rows'
  return 'full'
}

/** The levels from least to most: a part of the page shows from its level up. */
const ORDER: Level[] = ['glance', 'list', 'rows', 'full']
export const atLeast = (level: Level, least: Level): boolean => ORDER.indexOf(level) >= ORDER.indexOf(least)

/* ---- the queue ---- */

export interface QueueNow {
  running: number
  waiting: number
  most: number
}

export function queueNow(runs: readonly RunView[], machine: Pick<Machine, 'most'>): QueueNow {
  return { running: runs.filter((run) => run.state === 'running').length, waiting: runs.filter((run) => run.state === 'queued').length, most: machine.most }
}

/** How far back the queue's chart looks. */
export const QUEUE_WINDOW_MS = 30 * 60_000
const QUEUE_STEPS = 30

export interface QueuePoint {
  at: number
  /** How many runs were waiting in line at that moment. */
  waiting: number
  /** How many were running. */
  running: number
}

/**
 * How many runs were waiting and how many running at each of `steps` moments of the last `windowMs`,
 * oldest first, the last one now. A run waits from when it was queued until it started (or, cancelled
 * before it started, until it ended); it runs from its start until it ended.
 */
export function queueOver(runs: readonly RunView[], now: number, windowMs = QUEUE_WINDOW_MS, steps = QUEUE_STEPS): QueuePoint[] {
  const out: QueuePoint[] = []
  for (let step = 0; step <= steps; step++) {
    const at = now - windowMs + (windowMs * step) / steps
    const running = runs.filter((run) => run.startedAt !== null && run.startedAt <= at && (run.finishedAt === null ? run.state === 'running' : run.finishedAt > at)).length
    const waiting = runs.filter((run) => {
      if (run.queuedAt > at) return false
      const left = run.startedAt ?? run.finishedAt ?? (run.state === 'queued' ? Infinity : run.queuedAt)
      return left > at
    }).length
    out.push({ at, waiting, running })
  }
  return out
}

export function queueSaid(now: QueueNow): string {
  return `${now.waiting ? `${now.waiting} waiting` : 'none waiting'}, ${now.running} of ${now.most} running.`
}

/* ---- the strain ---- */

/** Whether the load holds new runs back: above the limit, nothing new starts until a run has waited its longest. */
export const holding = (machine: Pick<Machine, 'load' | 'loadAbove'>): boolean => machine.load > machine.loadAbove

export function strainSaid(machine: Pick<Machine, 'load' | 'loadAbove' | 'cores'>, samples: readonly Sample[]): string {
  const now = `Load ${machine.load.toFixed(1)} on ${machine.cores} cores; new runs wait above ${machine.loadAbove.toFixed(1)}`
  const held = holding(machine) ? ', so new runs are being held' : ''
  if (samples.length < 2) return `${now}${held}.`
  const loads = samples.map((one) => one.load)
  const minutes = Math.max(1, Math.round((samples.at(-1)!.at - samples[0]!.at) / 60_000))
  return `${now}${held}. Over the last ${minutes} min it went from ${Math.min(...loads).toFixed(1)} to ${Math.max(...loads).toFixed(1)}.`
}

/** The queue's footer text and its tile's words: "2 waiting · 1 running". */
export const queueLine = (now: Pick<QueueNow, 'running' | 'waiting'>): string => `${now.waiting ? `${now.waiting} waiting` : 'none waiting'} · ${now.running} running`

/* ---- the results ---- */

export type Ended = 'passed' | 'failed' | 'cancelled'
export interface Result {
  id: string
  label: string
  /** What the run was for (`verify`, `build`, `task`…), said on its tooltip. */
  kind?: string
  state: Ended
  /** How long it ran, in seconds; 0 for a run cancelled before it started. */
  seconds: number
  /** When it ended, ms since the epoch. */
  at: number
}

/** How many of the latest results the chart shows. */
export const RESULTS_SHOWN = 12

/** The latest runs that ended, oldest first. */
export function recentResults(runs: readonly RunView[], most = RESULTS_SHOWN): Result[] {
  return runs
    .filter((run): run is RunView & { state: Ended } => run.state === 'passed' || run.state === 'failed' || run.state === 'cancelled')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(0, most)
    .reverse()
    .map((run) => ({ id: run.id, label: run.label, kind: run.kind, state: run.state, seconds: run.startedAt !== null && run.finishedAt !== null ? Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000)) : 0, at: run.finishedAt ?? 0 }))
}

export function counts(results: readonly Result[]): Record<Ended, number> {
  const out: Record<Ended, number> = { passed: 0, failed: 0, cancelled: 0 }
  for (const one of results) out[one.state]++
  return out
}

export function resultsSaid(results: readonly Result[]): string {
  if (!results.length) return 'No results yet.'
  const n = counts(results)
  const parts = [`${n.passed} passed`, `${n.failed} failed`, ...(n.cancelled ? [`${n.cancelled} cancelled`] : [])]
  const last = results.at(-1)!
  return `The last ${results.length}: ${parts.join(', ')}. Latest: “${last.label}”${last.kind ? ` (${kindSaid(last.kind)})` : ''} ${last.state}.`
}

/* ---- the tiles in a narrow container ---- */

/*
 * The tiles carry no card of their own: no border, no background, no gap, only a hairline between
 * them and a tight padding. In one column a tile is a compact row — its title, a line in words and
 * its number on one line, the plot directly under it, edge to edge. Side by side, the words go on a
 * line of their own under the title. A narrow tile (under `AXES_FROM`) draws a sparkline, with no
 * axes and no grid; a wider one adds a y-axis with two ticks, the first and last time, and gridlines.
 */

/** From this tile width up, a chart has axes and gridlines; below it, a sparkline. */
export const AXES_FROM = 260
/** The plot's own height: a sparkline, and a chart with axes. Both are a comfortable touch target. */
export const SPARK_HEIGHT = 44
export const AXES_HEIGHT = 72
/** The hairline between tiles, in px: the grid's gap, showing the border colour behind the tiles. */
export const DIVIDER = 1
/** A tile's padding, in px: across, and above and below. A plot runs through the padding across. */
export const PAD_X = 8
export const PAD_Y = 6
/** A tile's head row (its title and number) and its line in words, in px; the gap under each row. */
export const HEAD_HEIGHT = 20
export const SUB_HEIGHT = 16
export const ROW_GAP = 2

export interface TileLayout {
  /** Tiles side by side: one under 360 px, then two (the grid's container query). */
  columns: number
  /** One tile's width, null until measured. */
  tile: number | null
  axes: boolean
  /** The plot's height in px. */
  plot: number
  /** One row per tile: title, words and number on one line, the plot under it. */
  compact: boolean
}

export function tileLayout(width: number | null): TileLayout {
  if (width === null || width <= 0) return { columns: 1, tile: null, axes: false, plot: SPARK_HEIGHT, compact: true }
  const columns = width < 360 ? 1 : 2
  const tile = Math.floor((width - DIVIDER * (columns - 1)) / columns)
  const axes = tile >= AXES_FROM
  return { columns, tile, axes, plot: axes ? AXES_HEIGHT : SPARK_HEIGHT, compact: columns === 1 }
}

/** How tall the two tiles stand in one column, in px: two rows and the hairline between. */
export function columnHeight(layout: TileLayout): number {
  const row = 2 * PAD_Y + HEAD_HEIGHT + ROW_GAP + (layout.compact ? 0 : SUB_HEIGHT + ROW_GAP) + layout.plot
  return 2 * row + DIVIDER
}

/** Which point a pointer `x` px across a plot `width` px wide is on: the nearest point of a line, the bar it is over. */
export function indexAt(x: number, width: number, count: number, kind: 'line' | 'bar'): number | null {
  if (count <= 0 || width <= 0) return null
  const at = Math.min(1, Math.max(0, x / width))
  const index = kind === 'line' ? Math.round(at * (count - 1)) : Math.floor(at * count)
  return Math.min(count - 1, Math.max(0, index))
}

/** Where a tooltip sits along its plot, so it never runs off the tile: under the point, kept inside. */
export function tipAlign(index: number, count: number): 'start' | 'center' | 'end' {
  if (count <= 1) return 'center'
  const at = index / (count - 1)
  return at < 1 / 3 ? 'start' : at > 2 / 3 ? 'end' : 'center'
}

/** The space between a tooltip and its plot, in px. */
export const TIP_GAP = 4

/**
 * Whether a tooltip goes above its plot or below it — outside the plot either way, so it never lies
 * over the chart's own labels. Above when it fits under the top of what clips the page (`room`: the
 * px from there to the plot's top), else below.
 */
export function tipSide(room: number, tipHeight: number): 'above' | 'below' {
  return room >= tipHeight + TIP_GAP ? 'above' : 'below'
}

/** The key that moves the point a chart's tooltip is on: the next index, null to close it, undefined for another key. */
export function stepped(key: string, index: number | null, count: number): number | null | undefined {
  if (!count) return undefined
  const from = index ?? count - 1
  if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(count - 1, index === null ? from : from + 1)
  if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, index === null ? from : from - 1)
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'Escape') return null
  return undefined
}

/** The top of a y-axis: a round number at or above the highest value. */
export function niceTop(max: number): number {
  if (!(max > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= max) return Math.round(step * power * 1000) / 1000
  return 10 * power
}

/**
 * A tooltip: three short lines at most. The value first (drawn bold), then what it means or which run
 * it is, then a muted note — the time of the point. An empty line is left out.
 */
export interface Tip {
  value: string
  detail: string
  note: string
}

/** The longest line a tooltip holds, in characters: it fits about 15 rem at 12 px without wrapping. */
export const TIP_LINE_MAX = 28

/** A tooltip's lines, in order, none empty. */
export const tipLines = (tip: Tip): string[] => [tip.value, tip.detail, tip.note].filter(Boolean)

/** A label cut to fit a tooltip's line. */
export const clip = (text: string, most = TIP_LINE_MAX): string => (text.length <= most ? text : `${text.slice(0, most - 1).trimEnd()}…`)

export const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

export function queueTip(point: QueuePoint, most: number): Tip {
  const free = most - point.running
  return {
    value: point.waiting ? `${point.waiting} waiting` : 'None waiting',
    detail: `${point.running} / ${most} running${point.waiting && free <= 0 ? ': full' : ''}`,
    note: clock(point.at),
  }
}

export function loadTip(point: Sample, machine: Pick<Machine, 'loadAbove'>): Tip {
  return { value: `Load ${point.load.toFixed(1)}`, detail: point.load > machine.loadAbove ? 'Holding new runs' : `Runs wait above ${machine.loadAbove.toFixed(1)}`, note: clock(point.at) }
}

