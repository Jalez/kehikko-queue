import { existsSync, watch, type FSWatcher } from 'node:fs'

import { events, publish, watching, type Stream } from 'kehikot-module-protocol/serve'

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
 *   While a page follows one that is running, the server watches that log file and looks at its size
 *   every `STAT_MS` where the watch is not told (Bun), and publishes when it grew (`look`).
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

/** How often the server looks at a followed running run's log size: the fallback when its watch is silent. */
export const STAT_MS = 750

interface Following {
  watcher: FSWatcher | null
  timer: ReturnType<typeof setTimeout> | null
  size: number | null
}

/** The runs whose output a page follows: each one's watch, its size look, and the size last seen. */
const followed = new Map<string, Following>()

/* Test seam: a file watch that is never told, as under Bun (see `watchLog`). */
let watchesTold = true
export function useWatches(told: boolean): void {
  watchesTold = told
}

/** How many size looks are scheduled (tests). */
export const statTimers = (): number => [...followed.values()].filter((one) => one.timer !== null).length

/** Stop following `id`: its watcher closed, its look stopped, its name forgotten. */
function unfollow(id: string): void {
  const one = followed.get(id)
  one?.watcher?.close()
  if (one?.timer) clearTimeout(one.timer)
  followed.delete(id)
}

/**
 * The fast path: a watch on the log FILE (not its folder) while a page follows it. Under Node
 * (Vite) and on Linux it is told of every write, the run's own included. Under Bun (the ready-built
 * server) it is not told of writes through a descriptor another process holds, which is how a run
 * writes (so it outlives this module): `look` below covers that.
 */
function watchLog(id: string, one: Following, file: string | null): void {
  if (one.watcher || !watchesTold || !file || !existsSync(file)) return
  try {
    const made = watch(file, () => {
      if (watching(outputTopic(id)) === 0) return unfollow(id)
      say(outputTopic(id), OUTPUT_GAP_MS)
    })
    made.on('error', () => {
      made.close()
      if (one.watcher === made) one.watcher = null
    })
    one.watcher = made
  } catch {
    /* A log that cannot be watched: `look` still notices it growing. */
  }
}

/**
 * The fallback: while a page follows a RUNNING run's output, look at its log's size every `STAT_MS`
 * (a `stat`, on this machine; the page asks nothing) and publish when it grew. One one-shot timer,
 * set again only while somebody follows and the run runs; stopped when the last stream on it closes
 * or the run ends.
 */
function look(id: string, sizeOf: (id: string) => number | null): void {
  const one = followed.get(id)
  if (!one) return
  one.timer = null
  const size = watching(outputTopic(id)) > 0 ? sizeOf(id) : null
  if (size === null) return unfollow(id)
  if (one.size !== null && size !== one.size) say(outputTopic(id), OUTPUT_GAP_MS)
  one.size = size
  one.timer = setTimeout(() => look(id, sizeOf), STAT_MS)
  one.timer.unref?.()
}

/** Stop every watcher and timer (tests, and a server that stops). */
export function stopWatching(): void {
  for (const id of [...followed.keys()]) unfollow(id)
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
 * id comes off the wire, so it is never made into a path here). `sizeOf` is that log's size while the
 * run runs, and null once it does not (or never did).
 */
export function makeStream(logOf: (id: string) => string | null, sizeOf: (id: string) => number | null): Stream {
  const inner = events((path, query) => {
    if (path === RUNS_EVENTS) return { topic: RUNS_TOPIC, initial: NEWS }
    if (path === OUTPUT_EVENTS) {
      const id = query.get('id')
      if (!id) return null
      return { topic: outputTopic(id), initial: NEWS }
    }
    return null
  })
  return (method, path, query, emit, ticket) => {
    const opened = inner(method, path, query, emit, ticket)
    const id = query.get('id')
    if (path !== OUTPUT_EVENTS || !id || !opened || !('close' in opened)) return opened
    /* Once the stream is on the topic (so `watching` counts it): the watch, and the look. */
    let one = followed.get(id)
    if (!one) {
      one = { watcher: null, timer: null, size: null }
      followed.set(id, one)
    }
    watchLog(id, one, logOf(id))
    if (!one.timer) look(id, sizeOf)
    /* The last stream on a run closing stops its watch and its look at once, not at their next turn. */
    return {
      close: () => {
        opened.close()
        if (watching(outputTopic(id)) === 0) unfollow(id)
      },
    }
  }
}
