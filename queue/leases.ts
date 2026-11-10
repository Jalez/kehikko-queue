import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

import { alive, capLog, exitFile, exitOf, logFile, readLog, shellSpawner, stopGroup, tailOf, type Spawner } from './runner.ts'
import type { Asker, By } from './queue.ts'

/**
 * Dev-server leases: a few slots (Settings › Modules, "Dev servers at once") in which an agent runs
 * a dev server on a free port, so sessions do not each leave a Vite running. Queue starts the server
 * itself, in a process group of its own, and stops that group — by its pid, never by name — when:
 *
 *  - the lease is released (the CLI that asked ends, `queue_cancel`, the person's Stop);
 *  - its time runs out (`until`);
 *  - the process that holds it has gone (the CLI killed without a word: `holder`);
 *  - the agent session that asked has ended (`sessionPid`).
 *
 * Kept in `<queue dir>/leases/leases.json` (no environment), with each server's output in
 * `leases/<id>.log`, so a restart of this module still knows which groups are its own to stop.
 */

export const PORT_RANGE: readonly [number, number] = [5280, 5299]
export const TTL_DEFAULT_MS = 60 * 60_000
export const TTL_MOST_MS = 8 * 60 * 60_000
/** Ended leases kept to show how each ended. */
export const ENDED_KEPT = 10

export type LeaseState = 'running' | 'ended'

export interface Lease {
  id: string
  /** The asker's secret for releasing it. Never published, never shown. */
  key: string
  label: string
  argv: string[]
  cwd: string
  project: string | null
  port: number
  asker: Asker
  /** The agent session's own process: when it has gone, so does the lease. Null: not known. */
  sessionPid: number | null
  startedAt: number
  /** When it runs out. */
  until: number
  pid: number | null
  state: LeaseState
  endedAt: number | null
  why: string | null
  exit: number | null
}

export type LeaseView = Omit<Lease, 'key'>

export interface LeaseAsk {
  argv: string[]
  cwd: string
  env: Record<string, string>
  label: string
  project: string | null
  range: readonly [number, number]
  ttlMs: number
  asker: Asker
  sessionPid: number | null
}

export interface LeasesOptions {
  dir: string
  most(): number
  clock?: () => number
  spawner?: Spawner
  /** Whether nothing listens on a port. Tests replace it. */
  free?: (port: number) => Promise<boolean>
  changed?(): void
}

const newId = () => `l${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
const newKey = () => randomBytes(18).toString('base64url')

/** A port range as a person writes it, "5280-5299"; null when it is not one. */
export function rangeOf(said: unknown): readonly [number, number] | null {
  if (said === undefined || said === null || said === '') return PORT_RANGE
  const match = typeof said === 'string' ? /^\s*(\d{2,5})\s*(?:-\s*(\d{2,5}))?\s*$/.exec(said) : null
  if (!match) return null
  const from = Number(match[1])
  const to = Number(match[2] ?? match[1])
  if (from < 1024 || to > 65535 || to < from || to - from > 1000) return null
  return [from, to]
}

/** Whether nothing on this machine listens on `port`, on IPv4 or IPv6 loopback. */
export async function portFree(port: number): Promise<boolean> {
  const tryOn = (host: string) =>
    new Promise<boolean | null>((done) => {
      const server = createServer()
      server.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'EADDRINUSE' || error.code === 'EACCES' ? false : null))
      server.listen({ port, host, exclusive: true }, () => server.close(() => done(true)))
    })
  const v4 = await tryOn('127.0.0.1')
  if (v4 === false) return false
  const v6 = await tryOn('::1')
  return v6 !== false && (v4 === true || v6 === true)
}

/** The command with `{port}` put in, for a server that takes its port as an argument. */
export const withPort = (argv: readonly string[], port: number) => argv.map((word) => word.replaceAll('{port}', String(port)))

export class Leases {
  readonly #leases = new Map<string, Lease>()
  readonly #clock: () => number
  readonly #spawner: Spawner
  readonly #free: (port: number) => Promise<boolean>
  /** Ports being taken right now, so two asks at once do not pick the same one. */
  readonly #taking = new Set<number>()

  constructor(readonly options: LeasesOptions) {
    this.#clock = options.clock ?? Date.now
    this.#spawner = options.spawner ?? shellSpawner
    this.#free = options.free ?? portFree
    for (const one of [this.#dir]) {
      mkdirSync(one, { recursive: true, mode: 0o700 })
      try {
        chmodSync(one, 0o700)
      } catch {
        /* Not ours to change. */
      }
    }
    this.#load()
  }

  get #dir() {
    return join(this.options.dir, 'leases')
  }

  get #file() {
    return join(this.#dir, 'leases.json')
  }

  #log = (id: string) => logFile(this.#dir, id)
  #exit = (id: string) => exitFile(this.#dir, `${id}.exit`)

  #load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.#file, 'utf8')) as { leases?: unknown }
      if (Array.isArray(parsed.leases)) {
        for (const one of parsed.leases as Lease[]) if (one && typeof one.id === 'string' && typeof one.port === 'number') this.#leases.set(one.id, one)
      }
    } catch {
      /* None kept yet. */
    }
    /* A server that ended while the module was away. */
    for (const lease of this.#leases.values()) {
      if (lease.state === 'running' && (lease.pid === null || !alive(lease.pid))) this.#ended(lease, exitOf(this.#exit(lease.id)), 'It stopped while Queue was away.', false)
    }
    this.#prune()
    this.#save()
  }

  #save(): void {
    try {
      const temporary = `${this.#file}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ version: 1, leases: [...this.#leases.values()] }, null, 1)}\n`, { mode: 0o600 })
      renameSync(temporary, this.#file)
    } catch {
      /* The folder is gone (a test's scratch). */
    }
  }

  #prune(): void {
    const ended = [...this.#leases.values()].filter((one) => one.state === 'ended').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    for (const lease of ended.slice(ENDED_KEPT)) {
      this.#leases.delete(lease.id)
      rmSync(this.#log(lease.id), { force: true })
      rmSync(this.#exit(lease.id), { force: true })
    }
    try {
      for (const name of readdirSync(this.#dir)) {
        const id = name.replace(/\.(log|exit)$/, '')
        if (name !== 'leases.json' && !name.endsWith('.tmp') && !this.#leases.has(id)) rmSync(join(this.#dir, name), { force: true })
      }
    } catch {
      /* Gone. */
    }
  }

  #changed(): void {
    this.#save()
    try {
      this.options.changed?.()
    } catch {
      /* Telling is a courtesy. */
    }
  }

  running(): Lease[] {
    return [...this.#leases.values()].filter((one) => one.state === 'running')
  }

  get(id: string): Lease | undefined {
    return this.#leases.get(id)
  }

  view(lease: Lease): LeaseView {
    const { key: _key, ...rest } = lease
    return rest
  }

  /** Running leases, oldest first, then the ones that ended lately, newest first. */
  list(): LeaseView[] {
    const running = this.running().sort((a, b) => a.startedAt - b.startedAt)
    const ended = [...this.#leases.values()].filter((one) => one.state === 'ended').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    return [...running, ...ended].map((one) => this.view(one))
  }

  /** Take a lease and start its server, or say in a sentence why not. */
  async take(ask: LeaseAsk): Promise<Lease | string> {
    const most = this.options.most()
    const held = this.running()
    if (held.length + this.#taking.size >= most) {
      const who = held.map((one) => `${one.label} on port ${one.port}`).join('; ')
      return most <= 0
        ? 'Dev servers are not leased on this computer (Dev servers at once is 0 in Settings › Modules).'
        : `All ${most} dev-server slots are taken${who ? ` (${who})` : ''}. Release one (end its command, or queue_cancel with its id) or try again later.`
    }
    const used = new Set([...held.map((one) => one.port), ...this.#taking])
    let port: number | null = null
    for (let at = ask.range[0]; at <= ask.range[1]; at++) {
      if (used.has(at)) continue
      this.#taking.add(at)
      if (await this.#free(at)) {
        port = at
        break
      }
      this.#taking.delete(at)
    }
    if (port === null) return `No port from ${ask.range[0]} to ${ask.range[1]} is free on this computer.`
    try {
      if (!existsSync(ask.cwd)) return `${ask.cwd} is not there.`
      const now = this.#clock()
      const lease: Lease = {
        id: newId(),
        key: newKey(),
        label: ask.label,
        argv: withPort(ask.argv, port),
        cwd: ask.cwd,
        project: ask.project,
        port,
        asker: ask.asker,
        sessionPid: ask.sessionPid,
        startedAt: now,
        until: now + Math.min(Math.max(60_000, ask.ttlMs), TTL_MOST_MS),
        pid: null,
        state: 'running',
        endedAt: null,
        why: null,
        exit: null,
      }
      let started
      try {
        started = this.#spawner.start({ argv: lease.argv, cwd: lease.cwd, env: { ...ask.env, PORT: String(port), KEHIKOT_QUEUE_LEASE: lease.id }, log: this.#log(lease.id), exit: this.#exit(lease.id) })
      } catch (error) {
        return `The dev server could not be started: ${error instanceof Error ? error.message : String(error)}`
      }
      lease.pid = started.pid
      this.#leases.set(lease.id, lease)
      this.#changed()
      void started.exited.then(
        (code) => {
          if (lease.state === 'running') this.#ended(lease, code, null)
        },
        (error: unknown) => {
          if (lease.state === 'running') this.#ended(lease, null, `It could not be run: ${error instanceof Error ? error.message : String(error)}`)
        },
      )
      return lease
    } finally {
      this.#taking.delete(port)
    }
  }

  /** Release a lease: its server's whole group is stopped. Null when released; a sentence when not. */
  release(id: string, by: By, why?: string): string | null {
    const lease = this.#leases.get(id)
    if (!lease) return 'There is no such lease.'
    if (!('person' in by) && !((by.key && by.key === lease.key) || (by.token && lease.asker.token && by.token === lease.asker.token))) {
      return 'That dev server is not yours to stop: only the session that leased it, or the person on the Queue page, can stop it.'
    }
    if (lease.state === 'ended') return 'That dev server has already stopped.'
    this.#stop(lease, why ?? ('person' in by ? 'Stopped by the person.' : 'Released by the session that leased it.'))
    return null
  }

  #stop(lease: Lease, why: string): void {
    if (lease.pid !== null) stopGroup(lease.pid)
    this.#ended(lease, null, why)
  }

  #ended(lease: Lease, code: number | null, why: string | null, tell = true): void {
    lease.state = 'ended'
    lease.exit = code
    lease.why = lease.why ?? why ?? (code === null ? null : `The server exited${code ? ` with code ${code}` : ''}.`)
    lease.endedAt = this.#clock()
    capLog(this.#log(lease.id))
    this.#prune()
    if (tell) this.#changed()
  }

  /** Look at every lease: its time, its holder, its session, its server. */
  tick(): void {
    const now = this.#clock()
    for (const lease of this.running()) {
      if (lease.pid !== null && !alive(lease.pid)) this.#ended(lease, exitOf(this.#exit(lease.id)), null)
      else if (now >= lease.until) this.#stop(lease, 'Its time ran out.')
      else if (typeof lease.asker.holder === 'number' && lease.asker.holder > 1 && !alive(lease.asker.holder)) this.#stop(lease, 'The command that leased it ended.')
      else if (lease.sessionPid !== null && lease.sessionPid > 1 && !alive(lease.sessionPid)) this.#stop(lease, 'The agent session that leased it ended.')
      else capLog(this.#log(lease.id))
    }
  }

  /** Stop every server (this module is stopping for good, or a test is done). */
  stopAll(why: string): void {
    for (const lease of this.running()) this.#stop(lease, why)
  }

  output(id: string, from: number, most?: number) {
    return readLog(this.#log(id), from, most)
  }

  tail(id: string, lines?: number): string {
    return tailOf(this.#log(id), lines)
  }
}

/** One lease in a few lines an agent reads. */
export function leaseSaid(lease: LeaseView, now = Date.now()): string {
  const left = Math.max(0, Math.round((lease.until - now) / 60_000))
  const head = `${lease.id} — dev server ${JSON.stringify(lease.label)} on port ${lease.port} (http://localhost:${lease.port}) — ${lease.state === 'running' ? `running, ${left} min left` : 'stopped'}`
  return [head, `  from ${lease.asker.said}`, `  in ${lease.cwd}: ${lease.argv.join(' ').slice(0, 200)}`, lease.state === 'ended' && lease.why ? `  ${lease.why}` : ''].filter(Boolean).join('\n')
}
