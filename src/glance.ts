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

/** How many runs were running at each of `steps` moments of the last `windowMs`, oldest first, the last one now. */
export function runningOver(runs: readonly RunView[], now: number, windowMs = QUEUE_WINDOW_MS, steps = QUEUE_STEPS): Array<{ at: number; running: number }> {
  const out: Array<{ at: number; running: number }> = []
  for (let step = 0; step <= steps; step++) {
    const at = now - windowMs + (windowMs * step) / steps
    const running = runs.filter((run) => run.startedAt !== null && run.startedAt <= at && (run.finishedAt === null ? run.state === 'running' : run.finishedAt > at)).length
    out.push({ at, running })
  }
  return out
}

export function queueSaid(now: QueueNow): string {
  return `${now.running} of ${now.most} running, ${now.waiting ? `${now.waiting} waiting` : 'none waiting'}.`
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

/* ---- the results ---- */

export type Ended = 'passed' | 'failed' | 'cancelled'
export interface Result {
  id: string
  label: string
  state: Ended
  /** How long it ran, in seconds; 0 for a run cancelled before it started. */
  seconds: number
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
    .map((run) => ({ id: run.id, label: run.label, state: run.state, seconds: run.startedAt !== null && run.finishedAt !== null ? Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000)) : 0 }))
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
  return `The last ${results.length}: ${parts.join(', ')}. Latest: “${last.label}” ${last.state}.`
}
