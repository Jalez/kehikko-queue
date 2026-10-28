import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { LIMITS, type RunResult } from 'kehikot-module-protocol'

import { alive, capLog, exitFile, exitOf, LOG_MOST, logFile, readLog, shellSpawner, stopGroup, tailOf, type Spawner } from './runner.ts'
import { decide, moved, ordered, priorityOf, waitingSaid, type Capacity, type Move } from './schedule.ts'
import { ensureDirs, exitDir, logsDir } from './machine.ts'

/**
 * The queue: every run asked for on this computer, from any session, in one list. It starts each
 * when `decide` says there is room, holds its process while it runs, and keeps what came of it.
 *
 * What is kept on disk (`runs.json` in the machine directory) is everything but the environment and
 * the caller's key — the environment lives only in memory, so a run still WAITING when this module
 * stops cannot be started later and is ended as cancelled ("the queue restarted"). A run already
 * RUNNING carries on in its own process group, and is picked up again by its pid and its exit file.
 */

export const RUN_KINDS = ['push', 'verify', 'review', 'other'] as const
export type Kind = (typeof RUN_KINDS)[number]
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
}

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
}

/** A run as anyone may see it: no key, no environment. */
export type RunView = Omit<Run, 'key'> & { position: number | null; waiting: string | null }

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
  /** How often the queue looks at the load and its runs, in ms. 0: only when asked (tests). */
  tickMs?: number
}

const newId = () => `r${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
const newKey = () => randomBytes(18).toString('base64url')
export const ended = (state: State) => state === 'passed' || state === 'failed' || state === 'cancelled'

export class Queue {
  readonly #runs = new Map<string, Run>()
  readonly #env = new Map<string, Record<string, string>>()
  readonly #waiters = new Set<() => void>()
  readonly #clock: () => number
  readonly #spawner: Spawner
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(readonly options: QueueOptions) {
    this.#clock = options.clock ?? Date.now
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
      } else if (run.state === 'running') {
        const code = exitOf(exitFile(exitDir(this.options.dir), run.id))
        if (code !== null) this.#end(run, code, null, false)
        else if (run.pid === null || !alive(run.pid)) Object.assign(run, { state: 'failed', finishedAt: now, why: 'It stopped while the queue was away and left no exit code.' })
        /* Else: still running in its own group; `tick` looks for its exit file. */
      }
      this.#runs.set(run.id, run)
    }
    this.#prune()
    this.#save()
  }

  #save(): void {
    const runs = [...this.#runs.values()]
    const temporary = `${this.#file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, runs }, null, 1)}\n`, { mode: 0o600 })
    renameSync(temporary, this.#file)
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
  cancel(id: string, by: { person: true } | { key?: string | null; token?: string | null }): string | null {
    const run = this.#runs.get(id)
    if (!run) return 'There is no such run.'
    if (!('person' in by)) {
      const owns = (by.key && by.key === run.key) || (by.token && run.asker.token && by.token === run.asker.token)
      if (!owns) return 'That run is not yours to cancel: only the session that asked for it, or the person on the Test runs page, can cancel it.'
    }
    if (ended(run.state)) return `That run has already ${run.state === 'passed' ? 'passed' : run.state === 'failed' ? 'failed' : 'been cancelled'}.`
    if (run.state === 'running' && run.pid !== null) stopGroup(run.pid)
    Object.assign(run, { state: 'cancelled', finishedAt: this.#clock(), why: 'person' in by ? 'Cancelled by the person.' : 'Cancelled by the session that asked for it.' })
    this.#env.delete(id)
    this.#changed(run)
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
      waiting: run.state === 'queued' ? waitingSaid(run.id, waiting, this.#running().length, this.options.load(), this.#clock(), this.options.capacity()) : null,
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

  /** Listen for any change. Returns the unlisten. */
  onChange(then: () => void): () => void {
    this.#waiters.add(then)
    return () => this.#waiters.delete(then)
  }

  /* ---- running ---- */

  /** Look at the load and the runs: start what may start, and notice what ended unwatched. */
  tick(): void {
    const dir = this.options.dir
    for (const run of this.#running()) {
      const log = logFile(logsDir(dir), run.id)
      capLog(log, LOG_MOST * 4)
      /* A run picked up after a restart has no process handle: its exit file says when it ends. */
      const code = exitOf(exitFile(exitDir(dir), run.id))
      if (code !== null) this.#end(run, code, null)
      else if (run.pid !== null && !alive(run.pid)) {
        const late = exitOf(exitFile(exitDir(dir), run.id))
        if (late !== null) this.#end(run, late, null)
        else this.#end(run, null, 'It stopped without an exit code.')
      }
    }
    for (;;) {
      const decision = decide(this.#waiting(), this.#running().length, this.options.load(), this.#clock(), this.options.capacity())
      if (decision.start === null) break
      this.#start(this.#runs.get(decision.start)!, decision.overdue)
    }
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
      const started = this.#spawner.start({ argv: run.argv, cwd: run.cwd, env, log: logFile(logsDir(this.options.dir), run.id), exit: exitFile(exitDir(this.options.dir), run.id) })
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

  #end(run: Run, code: number | null, why: string | null, tell = true): void {
    run.state = code === 0 ? 'passed' : 'failed'
    run.exit = code
    run.why = why
    run.finishedAt = this.#clock()
    run.pid = run.pid ?? null
    capLog(logFile(logsDir(this.options.dir), run.id))
    if (tell) this.#changed(run)
  }

  #changed(run: Run): void {
    this.#save()
    if (run.project && this.options.publish) this.options.publish(run.project, this.resultsFor(run.project))
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
        kind: run.kind,
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
