import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { LIMITS, type RunResult } from 'kehikot-module-protocol'

import { alive, capLog, exitFile, exitOf, LOG_MOST, logFile, readLog, shellSpawner, stopGroup, tailOf, type Spawner } from './runner.ts'
import { decide, moved, ordered, priorityOf, waitingSaid, type Capacity, type Move } from './schedule.ts'
import { ensureDirs, exitDir, logsDir } from './machine.ts'
import type { Origin } from './origin.ts'
import type { Expect } from './expect.ts'
import { FAST_MS, signatureOf } from './preflight.ts'
import { idleSince, look, SAMPLE_EVERY_MS, type Sampler, type Watch } from './idle.ts'
import { psSampler } from './idle-ps.ts'

/**
 * The queue: every run asked for on this computer, from any session, in one list. It starts each
 * when `decide` says there is room, holds its process while it runs, and keeps what came of it.
 *
 * What is kept on disk (`runs.json` in the machine directory) is everything but the environment and
 * the caller's key — the environment lives only in memory, so a run still WAITING when this module
 * stops cannot be started later and is ended as cancelled ("the queue restarted"). A run already
 * RUNNING carries on in its own process group, and is picked up again by its pid and its exit file.
 */

export { whoAsked } from './who.ts'
export { DEFAULT_KIND, isTests, KIND_WORDS, kindSaid, RUN_KINDS, type Kind } from './kinds.ts'
import { publishedKind, type Kind } from './kinds.ts'
export type State = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled'

export const LABEL_MOST = LIMITS.RUN_LABEL
export const ARGV_MOST = 256
export const ARGV_BYTES_MOST = 64 * 1024
/** Finished runs kept, newest first; older ones go with their logs. */
export const KEPT_FINISHED = 300
/** Logs and finished runs older than this go. */
export const LOG_DAYS = 7

/** Who asked, as a person reads it, and what the asker can be recognised by later. */
export interface Asker {
  /** "pre-push hook", "agent session", "a shell". */
  via: 'cli' | 'mcp'
  /** A sentence: which session, in which place. */
  said: string
  /** The place token the asker carried, or null: an MCP call with the same token owns the run. */
  token: string | null
  /** The conversation the place names, when it names one. */
  conversation: string | null
  /** The agent session that asked, as its agent CLI names it (passed by a hook, `--session`, or read from its environment). */
  session?: string | null
  /** Which agent asked, in its own words: a subagent's name, "claude-code". */
  agent?: string | null
  /**
   * The process that asked and waits (the CLI's own pid): a run still WAITING when it has gone is
   * cancelled, since nobody will read its result. Null: not known, or an agent's MCP call.
   */
  holder?: number | null
}


export interface Ask {
  argv: string[]
  cwd: string
  env: Record<string, string>
  kind: Kind
  label: string
  refs: string[]
  epic: string | null
  project: string | null
  asker: Asker
  /** Where it came from, as far as was known; absent is unknown. */
  origin?: Origin | null
  /** 'fail' when the asker means it to fail (a red test first); absent is meant to pass. */
  expect?: Expect | null
}

/** Who may act on a run as its own: the person, or a caller with its key or the place token that asked. */
export type By = { person: true } | { key?: string | null; token?: string | null }

export interface Run {
  id: string
  /** The caller's secret for cancelling its own run. Never published, never shown. */
  key: string
  label: string
  kind: Kind
  refs: string[]
  epic: string | null
  project: string | null
  argv: string[]
  cwd: string
  asker: Asker
  /** Where it came from, for the jump-into button. Null: unknown (a run kept before this was recorded has none). */
  origin: Origin | null
  state: State
  /** Why it ended the way it did, when that is not plain from the exit code. */
  why: string | null
  pri: number
  rank: number
  queuedAt: number
  startedAt: number | null
  finishedAt: number | null
  exit: number | null
  pid: number | null
  /** Whether it started past the load guard, having waited its longest. */
  overdue: boolean
  /** 'fail': the asker meant it to fail. Its result is said with "as expected" or "expected to fail". */
  expect?: Expect | null
}

/** What 0.5.0 and 0.6.0 kept on a run for asking the person, which nothing reads any more: dropped as runs are read. */
const RETIRED = ['seenAt', 'seenBy', 'supersededBy', 'askerToldAt'] as const

/** A run as anyone may see it: no key, no environment. */
export type RunView = Omit<Run, 'key'> & {
  position: number | null
  waiting: string | null
  /** Since when a running run has used almost no CPU (issue #48), or null. Only ever flagged, never acted on. */
  idleSince: number | null
}

export interface QueueOptions {
  dir: string
  capacity(): Capacity
  load(): number
  clock?: () => number
  spawner?: Spawner
  /** Told each project whose runs changed, with its runs as the protocol's run results. */
  publish?(project: string, runs: RunResult[]): void
  /** Told whenever anything changed. */
  changed?(): void
  /** Told after every look at the load and the runs (`tick`), changed or not: for what moves with the load. */
  ticked?(): void
  /** How the processes of the running runs are looked at, for idle slots. Default: `ps`. Tests pass their own, or none (`null`). */
  sampler?: Sampler | null
  /** How long a run may use almost no CPU before it is flagged, in ms. */
  idleMs?: number
  /** How often the queue looks at the load and its runs, in ms. 0: only when asked (tests). */
  tickMs?: number
  /**
   * Told once when a run ends, however it ended, with whether anyone was waiting on it at that moment
   * (`watch`: a `queue_wait`, a CLI following it). Not told for a run its own asker cancelled.
   */
  ended?(run: Run, watched: boolean): void
}

const newId = () => `r${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
const newKey = () => randomBytes(18).toString('base64url')
/** When a run's shell wrote its exit code: when it ended, for a run nobody was watching. */
function endedAt(file: string): number | null {
  try {
    return Math.round(statSync(file).mtimeMs)
  } catch {
    return null
  }
}

/** Whether `by` may act on the run as its own. */
function owns(run: Run, by: By): boolean {
  if ('person' in by) return true
  return !!((by.key && by.key === run.key) || (by.token && run.asker.token && by.token === run.asker.token))
}

export const ended = (state: State) => state === 'passed' || state === 'failed' || state === 'cancelled'

export class Queue {
  readonly #runs = new Map<string, Run>()
  readonly #env = new Map<string, Record<string, string>>()
  readonly #waiters = new Set<() => void>()
  /** How many are waiting on each run now (`watch`). */
  readonly #watched = new Map<string, number>()
  readonly #clock: () => number
  readonly #spawner: Spawner
  #timer: ReturnType<typeof setInterval> | null = null
  /** What each running run's tree used at the last look, for idle slots. Memory only. */
  readonly #watches = new Map<string, Watch>()
  readonly #flagged = new Set<string>()
  #sampled = 0
  #sampling = false
  readonly #sampler: Sampler | null

  constructor(readonly options: QueueOptions) {
    this.#clock = options.clock ?? Date.now
    this.#sampler = options.sampler === undefined ? psSampler : options.sampler
    this.#spawner = options.spawner ?? shellSpawner
    ensureDirs(options.dir)
    this.#load()
    if (options.tickMs) {
      this.#timer = setInterval(() => this.tick(), options.tickMs)
      this.#timer.unref?.()
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /* ---- what is kept ---- */

  get #file() {
    return join(this.options.dir, 'runs.json')
  }

  #load(): void {
    let kept: Run[] = []
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8')) as { runs?: unknown }
      if (Array.isArray(parsed.runs)) kept = parsed.runs.filter((one): one is Run => !!one && typeof (one as Run).id === 'string' && typeof (one as Run).state === 'string')
    } catch {
      /* Nothing kept yet, or unreadable: an empty queue. */
    }
    const now = this.#clock()
    for (const run of kept) {
      if (run.state === 'queued') {
        Object.assign(run, { state: 'cancelled', finishedAt: now, why: 'The queue restarted before this run started. Ask for it again.' })
        this.#told(run)
      } else if (run.state === 'running') {
        const code = exitOf(exitFile(exitDir(this.options.dir), run.id))
        if (code !== null) this.#end(run, code, null, false, endedAt(exitFile(exitDir(this.options.dir), run.id)))
        else if (run.pid === null || !alive(run.pid)) {
          Object.assign(run, { state: 'failed', finishedAt: now, why: 'It stopped while the queue was away and left no exit code.' })
          this.#told(run)
        }
        /* Else: still running in its own group; `tick` looks for its exit file. */
      }
      for (const key of RETIRED) delete (run as unknown as Record<string, unknown>)[key]
      this.#runs.set(run.id, run)
    }
    this.#prune()
    this.#save()
  }

  #save(): void {
    /* A run's process can exit after the queue was stopped and its folder removed (a test's
       scratch): there is then nothing to keep, and that is not an error. */
    try {
      const runs = [...this.#runs.values()]
      const temporary = `${this.#file}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ version: 1, runs }, null, 1)}\n`, { mode: 0o600 })
      renameSync(temporary, this.#file)
    } catch {
      /* The folder is gone: the queue is not keeping state any more. */
    }
  }

  #prune(): void {
    const now = this.#clock()
    const finished = [...this.#runs.values()].filter((run) => ended(run.state)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    finished.forEach((run, at) => {
      if (at >= KEPT_FINISHED || now - (run.finishedAt ?? now) > LOG_DAYS * 86_400_000) this.#forget(run.id)
    })
    /* A log nothing names any more. */
    for (const folder of [logsDir(this.options.dir), exitDir(this.options.dir)]) {
      let names: string[] = []
      try {
        names = readdirSync(folder)
      } catch {
        continue
      }
      for (const name of names) {
        const id = name.replace(/\.log$/, '')
        if (this.#runs.has(id)) continue
        try {
          if (now - statSync(join(folder, name)).mtimeMs > 60_000) rmSync(join(folder, name), { force: true })
        } catch {
          /* Gone already. */
        }
      }
    }
  }

  #forget(id: string): void {
    this.#runs.delete(id)
    this.#env.delete(id)
    rmSync(logFile(logsDir(this.options.dir), id), { force: true })
    rmSync(exitFile(exitDir(this.options.dir), id), { force: true })
  }

  /* ---- asking ---- */

  enqueue(ask: Ask): Run {
    const now = this.#clock()
    const run: Run = {
      id: newId(),
      key: newKey(),
      label: ask.label,
      kind: ask.kind,
      refs: ask.refs,
      epic: ask.epic,
      project: ask.project,
      argv: ask.argv,
      cwd: ask.cwd,
      asker: ask.asker,
      origin: ask.origin ?? null,
      state: 'queued',
      why: null,
      pri: priorityOf(ask.kind),
      rank: now,
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      exit: null,
      pid: null,
      overdue: false,
      expect: ask.expect ?? null,
    }
    this.#runs.set(run.id, run)
    this.#env.set(run.id, ask.env)
    this.#changed(run)
    this.tick()
    return run
  }

  /**
   * Cancel a run. `by` is who asks: the person (always), or a caller with the run's key or its
   * place token. Null when it was cancelled; a sentence when it was not.
   */
  cancel(id: string, by: By): string | null {
    const run = this.#runs.get(id)
    if (!run) return 'There is no such run.'
    if (!owns(run, by)) return 'That run is not yours to cancel: only the session that asked for it, or the person on the Queue page, can cancel it.'
    if (ended(run.state)) return `That run has already ${run.state === 'passed' ? 'passed' : run.state === 'failed' ? 'failed' : 'been cancelled'}.`
    if (run.state === 'running' && run.pid !== null) stopGroup(run.pid)
    Object.assign(run, { state: 'cancelled', finishedAt: this.#clock(), why: 'person' in by ? 'Cancelled by the person.' : 'Cancelled by the session that asked for it.' })
    this.#env.delete(id)
    this.#changed(run)
    /* The asker that cancelled its own run knows; the person's cancel is news to it. */
    if ('person' in by) this.#told(run)
    this.tick()
    return null
  }

  /** The person moves a waiting run. Null when moved; a sentence when not. */
  move(id: string, to: Move): string | null {
    const run = this.#runs.get(id)
    if (!run || run.state !== 'queued') return 'Only a waiting run can be moved.'
    const next = moved(this.#waiting(), id, to)
    if (!next) return to === 'down' ? 'It is already last.' : 'It is already first.'
    run.pri = next.pri
    run.rank = next.rank
    this.#changed(run)
    return null
  }

  /* ---- looking ---- */

  get(id: string): Run | undefined {
    return this.#runs.get(id)
  }

  #waiting(): Run[] {
    return [...this.#runs.values()].filter((run) => run.state === 'queued')
  }

  #running(): Run[] {
    return [...this.#runs.values()].filter((run) => run.state === 'running')
  }

  view(run: Run): RunView {
    const { key: _key, ...rest } = run
    const waiting = this.#waiting()
    const at = ordered(waiting).findIndex((one) => one.id === run.id)
    return {
      ...rest,
      position: at < 0 ? null : at + 1,
      idleSince: run.state === 'running' ? idleSince(this.#watches.get(run.id) ?? null, this.#clock(), this.options.idleMs) : null,
      waiting: run.state === 'queued' ? waitingSaid(run.id, waiting, this.#running(), this.options.load(), this.#clock(), this.options.capacity()) : null,
    }
  }

  /** Every run: waiting in the order they start, then running, then finished, newest first. */
  list(): RunView[] {
    const waiting = ordered(this.#waiting())
    const running = this.#running().sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    const finished = [...this.#runs.values()].filter((run) => ended(run.state)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    return [...waiting, ...running, ...finished].map((run) => this.view(run))
  }

  output(id: string, from: number, most?: number) {
    return readLog(logFile(logsDir(this.options.dir), id), from, most)
  }

  tail(id: string, lines?: number): string {
    return tailOf(logFile(logsDir(this.options.dir), id), lines)
  }

  /** Resolves with the run when it has ended, or when `ms` has passed, whichever is first. */
  wait(id: string, ms: number): Promise<Run | undefined> {
    return new Promise((resolve) => {
      const done = () => {
        const run = this.#runs.get(id)
        if (!run || ended(run.state)) {
          clearTimeout(timer)
          this.#waiters.delete(done)
          resolve(run)
        }
      }
      const timer = setTimeout(() => {
        this.#waiters.delete(done)
        resolve(this.#runs.get(id))
      }, Math.max(0, ms))
      this.#waiters.add(done)
      done()
    })
  }

  /** Say that someone waits on this run until the returned function is called: its end is then not news (`ended`). */
  watch(id: string): () => void {
    this.#watched.set(id, (this.#watched.get(id) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const left = (this.#watched.get(id) ?? 1) - 1
      if (left > 0) this.#watched.set(id, left)
      else this.#watched.delete(id)
    }
  }

  /** Listen for any change. Returns the unlisten. */
  onChange(then: () => void): () => void {
    this.#waiters.add(then)
    return () => this.#waiters.delete(then)
  }

  /* ---- running ---- */

  /** Look at the load and the runs: start what may start, and notice what ended unwatched. */
  tick(): void {
    const dir = this.options.dir
    /* A waiting run whose asker has gone (its CLI was killed, its shell closed): nobody will read it. */
    for (const run of this.#waiting()) {
      if (typeof run.asker.holder === 'number' && run.asker.holder > 0 && !alive(run.asker.holder)) {
        Object.assign(run, { state: 'cancelled', finishedAt: this.#clock(), why: 'The command that asked for it stopped waiting before it started.' })
        this.#env.delete(run.id)
        this.#changed(run)
      }
    }
    for (const run of this.#running()) {
      const log = logFile(logsDir(dir), run.id)
      capLog(log, LOG_MOST * 4)
      /* A run picked up after a restart has no process handle: its exit file says when it ends. */
      const code = exitOf(exitFile(exitDir(dir), run.id))
      if (code !== null) this.#end(run, code, null, true, endedAt(exitFile(exitDir(dir), run.id)))
      else if (run.pid !== null && !alive(run.pid)) {
        const late = exitOf(exitFile(exitDir(dir), run.id))
        if (late !== null) this.#end(run, late, null)
        else this.#end(run, null, 'It stopped without an exit code.')
      }
    }
    this.#lookAtIdle()
    for (;;) {
      const decision = decide(this.#waiting(), this.#running(), this.options.load(), this.#clock(), this.options.capacity())
      if (decision.start === null) break
      this.#start(this.#runs.get(decision.start)!, decision.overdue)
    }
    this.options.ticked?.()
  }

  /**
   * Look at what the running runs' processes use, at most every `SAMPLE_EVERY_MS`, without waiting for
   * the answer (a look is a `ps`). A run that was not flagged and now is, or the other way, is a change
   * the page hears about. Never cancels anything.
   */
  #lookAtIdle(): void {
    const sampler = this.#sampler
    const now = this.#clock()
    const running = this.#running().filter((run) => run.pid !== null)
    for (const id of [...this.#watches.keys()]) {
      if (running.some((run) => run.id === id)) continue
      this.#watches.delete(id)
      this.#flagged.delete(id)
    }
    if (!sampler || this.#sampling || !running.length || now - this.#sampled < SAMPLE_EVERY_MS) return
    this.#sampled = now
    this.#sampling = true
    void sampler(running.map((run) => run.pid!)).then(
      (seen) => {
        this.#sampling = false
        if (!seen) return
        let changed = false
        const at = this.#clock()
        for (const run of this.#running()) {
          const cpu = run.pid === null ? undefined : seen.get(run.pid)
          if (!cpu) continue
          const next = look(this.#watches.get(run.id) ?? null, cpu, at)
          const flagged = idleSince(next, at, this.options.idleMs) !== null
          if (flagged !== this.#flagged.has(run.id)) changed = true
          if (flagged) this.#flagged.add(run.id)
          else this.#flagged.delete(run.id)
          this.#watches.set(run.id, next)
        }
        if (changed) {
          for (const waiter of [...this.#waiters]) waiter()
          this.options.changed?.()
        }
      },
      () => {
        this.#sampling = false
      },
    )
  }

  #start(run: Run, overdue: boolean): void {
    const env = this.#env.get(run.id)
    const now = this.#clock()
    run.startedAt = now
    run.overdue = overdue
    if (!env) {
      this.#end(run, null, 'Its environment was lost before it started.')
      return
    }
    try {
      if (!existsSync(run.cwd)) throw new Error(`${run.cwd} is not there any more.`)
      /* KEHIKOT_QUEUE_RUN: a `kehikot-queue run` inside this run runs at once instead of queueing behind it. */
      const started = this.#spawner.start({ argv: run.argv, cwd: run.cwd, env: { ...env, KEHIKOT_QUEUE_RUN: run.id }, log: logFile(logsDir(this.options.dir), run.id), exit: exitFile(exitDir(this.options.dir), run.id) })
      run.state = 'running'
      run.pid = started.pid
      this.#env.delete(run.id)
      this.#changed(run)
      void started.exited.then(
        (code) => {
          if (run.state === 'running') this.#end(run, code, null)
          this.tick()
        },
        (error: unknown) => {
          if (run.state === 'running') this.#end(run, null, `It could not be run: ${error instanceof Error ? error.message : String(error)}`)
          this.tick()
        },
      )
    } catch (error) {
      this.#env.delete(run.id)
      this.#end(run, null, `It could not be started: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #end(run: Run, code: number | null, why: string | null, tell = true, at: number | null = null): void {
    run.state = code === 0 ? 'passed' : 'failed'
    run.exit = code
    run.why = why
    run.finishedAt = at ?? this.#clock()
    run.pid = run.pid ?? null
    capLog(logFile(logsDir(this.options.dir), run.id))
    /* A run that failed at once usually says why in its first lines: a fault in the folder, not the work (issue #28). */
    if (code !== 0 && why === null && run.startedAt !== null && run.finishedAt - run.startedAt <= FAST_MS) {
      const said = signatureOf(this.tail(run.id, 60))
      if (said) run.why = `It failed ${Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000))} s after it started, which looks like the folder, not the work: ${said}`
    }
    if (tell) this.#changed(run)
    this.#told(run)
  }

  /** Tell `ended` once about a run that ended. */
  #told(run: Run): void {
    try {
      this.options.ended?.(run, (this.#watched.get(run.id) ?? 0) > 0)
    } catch {
      /* Telling is a courtesy: it never stops the queue. */
    }
  }

  #changed(run: Run): void {
    this.#save()
    if (this.options.publish && run.project) this.options.publish(run.project, this.resultsFor(run.project))
    for (const waiter of [...this.#waiters]) waiter()
    this.options.changed?.()
  }

  /** One project's runs, as the protocol's run results, oldest first. */
  resultsFor(project: string): RunResult[] {
    return [...this.#runs.values()]
      .filter((run) => run.project === project)
      .sort((a, b) => a.queuedAt - b.queuedAt)
      .slice(-LIMITS.RUNS)
      .map((run) => ({
        id: run.id,
        label: run.label,
        kind: publishedKind(run.kind),
        refs: run.refs,
        epic: run.epic,
        state: run.state,
        queuedAt: run.queuedAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        exit: run.exit,
      }))
  }
}
