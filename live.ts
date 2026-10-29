import { existsSync, watch, type FSWatcher } from 'node:fs'

import { events, publish, watching } from 'kehikot-module-protocol/serve'

/**
 * Telling the page that the queue or a run's output changed, over one held stream each: the page
 * never asks on a clock (protocol 2.32.0, `events`/`subscribe`). What travels is that there IS news;
 * the page reads `/api/runs` or `/api/output` again, the doors it already reads.
 *
 * - **The queue** (`/api/runs/events`, topic `runs`): published at every change of a run's state —
 *   asked for (`queue_run`, the CLI), started, finished, cancelled (`queue_cancel`, the page), moved —
 *   from the queue's own `changed` (`runsChanged`). The queue's existing look at the load (`tick`, its
 *   scheduling) also publishes when what a waiting run says has changed ("the machine's load is 3.1 …,
 *   or in 4 minutes anyway"), which moves with the load and the clock and with no run changing
 *   (`waitingMoved`). Nothing is published while nothing waits and nothing changes.
 * - **A run's output** (`/api/output/events?id=…`, topic `output:<id>`): the run writes its log
 *   itself (its own process, straight into the file, so that it outlives a restart of this module).
 *   While a page follows one, the server watches that log file and publishes when it grows; the
 *   queue's own look at its runs backs that up where the file system does not tell (`outputsMoved`).
 */

export const RUNS_EVENTS = '/api/runs/events'
export const OUTPUT_EVENTS = '/api/output/events'

/** The news itself. The page re-reads on any event; the first is sent as a stream opens. */
export const NEWS = { changed: true } as const

export const RUNS_TOPIC = 'runs'
export const outputTopic = (id: string) => `output:${id}`

/** The least time between two pieces of news about one run's output: what the drawer's old poll asked. */
export const OUTPUT_GAP_MS = 1000
/* Several changes in one breath (a run asked for, then started at once) are one piece of news. */
const SETTLE_MS = 100

const pending = new Map<string, ReturnType<typeof setTimeout>>()
const lastSaid = new Map<string, number>()

/** Say `topic` changed, at most once per `gap`. One one-shot timer per topic; nothing repeats. */
function say(topic: string, gap = 0): void {
  if (pending.has(topic) || watching(topic) === 0) return
  const wait = Math.max(SETTLE_MS, (lastSaid.get(topic) ?? 0) + gap - Date.now())
  pending.set(
    topic,
    setTimeout(() => {
      pending.delete(topic)
      lastSaid.set(topic, Date.now())
      publish(topic, NEWS)
    }, wait),
  )
}

/** The queue changed: a run asked for, started, ended, cancelled or moved. */
export function runsChanged(): void {
  say(RUNS_TOPIC)
}

let waitingWas = ''
/**
 * After the queue's look at the load: publish when what the waiting runs say has moved. `said` is
 * asked only while a page follows the queue.
 */
export function waitingMoved(said: () => string): void {
  if (watching(RUNS_TOPIC) === 0) return
  const now = said()
  if (now === waitingWas) return
  waitingWas = now
  runsChanged()
}

/** The runs whose output a page follows, and the watcher on each one's log (when it has one yet). */
const followed = new Map<string, FSWatcher | null>()

/** Stop following `id`: its watcher closed, its name forgotten. */
function unfollow(id: string): void {
  followed.get(id)?.close()
  followed.delete(id)
}

/**
 * Watch one run's log while a page follows its output. A watch on the FILE, not its folder: the run
 * writes through a descriptor it was handed, and only a file's own watch (kqueue on macOS, inotify on
 * Linux) is told of that. Closed at its next event, or at the queue's next look, once nobody follows.
 */
function watchLog(id: string, file: string | null): void {
  if (followed.get(id) || !file || !existsSync(file)) return
  try {
    const made = watch(file, () => {
      if (watching(outputTopic(id)) === 0) return unfollow(id)
      say(outputTopic(id), OUTPUT_GAP_MS)
    })
    made.on('error', () => {
      made.close()
      if (followed.get(id) === made) followed.set(id, null)
    })
    followed.set(id, made)
  } catch {
    /* A log that cannot be watched: the queue's own look below still notices it growing. */
  }
}

const sizes = new Map<string, number>()
/**
 * After the queue's look at the load and its runs (`tick`, every few seconds, which it does anyway to
 * start runs and notice ends): publish for each followed run whose log has grown since. Under Bun
 * (the ready-built server) a file's watch is not told of writes through a descriptor another process
 * holds, so this is how the drawer hears of them there; under Node (Vite) and on Linux the watch
 * above is first. `sizeOf` is asked only for runs a page follows. Watchers nobody follows are closed.
 */
export function outputsMoved(sizeOf: (id: string) => number | null): void {
  for (const id of [...followed.keys()]) {
    if (watching(outputTopic(id)) === 0) {
      unfollow(id)
      sizes.delete(id)
      continue
    }
    const size = sizeOf(id)
    if (size === null) continue
    if (sizes.has(id) && sizes.get(id) !== size) say(outputTopic(id), OUTPUT_GAP_MS)
    sizes.set(id, size)
  }
}

/** Stop every watcher and timer (tests, and a server that stops). */
export function stopWatching(): void {
  for (const id of [...followed.keys()]) unfollow(id)
  sizes.clear()
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
}

/** Forget what is waiting to be said and when (tests). */
export function forgetSaid(): void {
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
  lastSaid.clear()
  waitingWas = ''
}

/**
 * The doors' `stream` option. `logOf` names a run's log file, or null for a run there is none of (the
 * id comes off the wire, so it is never made into a path here).
 */
export const makeStream = (logOf: (id: string) => string | null) =>
  events((path, query) => {
    if (path === RUNS_EVENTS) return { topic: RUNS_TOPIC, initial: NEWS }
    if (path === OUTPUT_EVENTS) {
      const id = query.get('id')
      if (!id) return null
      if (!followed.has(id)) followed.set(id, null)
      watchLog(id, logOf(id))
      return { topic: outputTopic(id), initial: NEWS }
    }
    return null
  })
