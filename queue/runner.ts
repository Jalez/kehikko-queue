import { closeSync, existsSync, ftruncateSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

/**
 * Running one command: in its own process group, with its output in a file, and its exit code
 * written by its own shell — so a run outlives a restart of this module (the host stops a module's
 * process group, not the runs', which are groups of their own) and its result is still known after.
 *
 * The command is run as `sh -c '"$@"; c=$?; printf %s "$c" > <exit file>; exit $c' <exit file> <argv…>`:
 * the argv exactly as given, looked up on the run's own PATH, and the exit status passed through
 * unchanged — a command ended by a signal gives the shell's 128+n, as it would in a hook.
 */

/** The shell line around every run. `$0` is the exit file; `$@` is the command. */
export const WRAPPER = '"$@"; c=$?; printf %s "$c" > "$0"; exit $c'

/** At most this much of a run's output is kept: the head and the tail, with a line between. */
export const LOG_MOST = 8 * 1024 * 1024
const LOG_HEAD = 1024 * 1024

export interface Started {
  pid: number
  /** Resolves with the exit code (or 128+signal) when the run ends while this process holds it. */
  exited: Promise<number>
}

export interface Spawner {
  start(run: { argv: readonly string[]; cwd: string; env: Record<string, string>; log: string; exit: string }): Started
}

export const shellSpawner: Spawner = {
  start({ argv, cwd, env, log, exit }) {
    rmSync(exit, { force: true })
    const fd = openSync(log, 'a', 0o600)
    try {
      /* node's spawn, which Vite's server (node) and the built one (Bun) both have. */
      const child = spawn('/bin/sh', ['-c', WRAPPER, exit, ...argv], {
        cwd,
        env,
        stdio: ['ignore', fd, fd],
        /* Its own session and process group: what stops this module does not stop the run, and a cancel stops the whole run. */
        detached: true,
      })
      const exited = new Promise<number>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => {
          if (typeof code === 'number') return resolve(code)
          resolve(exitOf(exit) ?? 128 + signalNumber(signal))
        })
      })
      if (child.pid === undefined) throw new Error('the shell did not start')
      return { pid: child.pid, exited }
    } finally {
      closeSync(fd)
    }
  },
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGABRT: 6, SIGSEGV: 11, SIGPIPE: 13 }
function signalNumber(signal: string | null): number {
  return signal && SIGNALS[signal] ? SIGNALS[signal]! : 1
}

/** The exit code a run's shell wrote, or null when it wrote none (still running, or killed whole). */
export function exitOf(file: string): number | null {
  try {
    const said = readFileSync(file, 'utf8').trim()
    return /^\d{1,3}$/.test(said) ? Number(said) : null
  } catch {
    return null
  }
}

/** Whether a process is still there. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

/** Stop a run's whole process group: TERM, then KILL after `graceMs` if anything is left. */
export function stopGroup(pid: number, graceMs = 5000): void {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* Gone. */
    }
  }, graceMs)
  timer.unref?.()
}

/** Bytes of a run's log from `from`, at most `most`, as text, and where the next read starts. */
export function readLog(file: string, from: number, most = 256 * 1024): { text: string; next: number; size: number } {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return { text: '', next: 0, size: 0 }
  }
  const start = from > size ? 0 : Math.max(0, from)
  const length = Math.min(most, size - start)
  if (length <= 0) return { text: '', next: start, size }
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const got = readSync(fd, buffer, 0, length, start)
    /* Never split a character: stop before an unfinished UTF-8 sequence at the end. */
    let end = got
    let at = got - 1
    let continuing = 0
    while (at >= 0 && continuing < 3 && (buffer[at]! & 0xc0) === 0x80) {
      at--
      continuing++
    }
    if (at >= 0) {
      const lead = buffer[at]!
      const needs = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
      if (needs > continuing + 1) end = at
    }
    return { text: buffer.subarray(0, end).toString('utf8'), next: start + end, size }
  } finally {
    closeSync(fd)
  }
}

/** The last `lines` lines of a log, at most `bytes` of it. */
export function tailOf(file: string, lines = 60, bytes = 16 * 1024): string {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return ''
  }
  const read = readLog(file, Math.max(0, size - bytes), bytes)
  const all = read.text.split('\n')
  if (all.at(-1) === '') all.pop()
  return all.slice(-lines).join('\n')
}

/**
 * Keep a log within `most` bytes: its first megabyte, a line saying how much was left out, and its
 * end. Safe while the run still writes: the file is opened for appending, so the run's next write
 * lands after what is kept.
 */
export function capLog(file: string, most = LOG_MOST): boolean {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return false
  }
  if (size <= most) return false
  const head = readLog(file, 0, LOG_HEAD).text
  const keepTail = most - LOG_HEAD - 200
  const tail = readLog(file, size - keepTail, keepTail).text
  const fd = openSync(file, 'r+')
  try {
    ftruncateSync(fd, 0)
    writeSync(fd, `${head}\n… ${size - LOG_HEAD - keepTail} bytes of output left out here …\n${tail}`, 0)
  } finally {
    closeSync(fd)
  }
  return true
}

export const logFile = (logs: string, id: string) => join(logs, `${id}.log`)
export const exitFile = (exits: string, id: string) => join(exits, id)
export const there = existsSync
