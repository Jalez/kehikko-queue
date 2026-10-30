import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

/**
 * This module's machine state: runs are machine-wide (one queue for every project and every session
 * on this computer), so the queue, the run logs, the settings and the CLI's token are kept in the
 * machine's Kehikot directory, never in a project:
 *
 *   ~/Library/Application Support/Kehikot/queue/     (macOS; $XDG_DATA_HOME/kehikot/queue elsewhere)
 *     runs.json        the queue and the finished runs (no environment, ever)
 *     settings.json    capacity, from Kehikot's Settings › Modules
 *     token            the CLI's way in: 0600, readable only by this user
 *     logs/<id>.log    each run's output, capped, pruned after LOG_DAYS
 *     exit/<id>        each run's exit code, written by the run's own shell
 *
 * `KEHIKOT_QUEUE_DIR` puts it elsewhere (the tests, a scratch run). Spelled once, in the CLI, which
 * imports nothing but node's own modules, so the server and the CLI cannot look in different places.
 */
export { queueDir } from '../bin/kehikot-queue.ts'

export const logsDir = (dir: string) => join(dir, 'logs')
export const exitDir = (dir: string) => join(dir, 'exit')
export const TOKEN_FILE = 'token'

/** Make the folders, readable only by this user. */
export function ensureDirs(dir: string): void {
  for (const one of [dir, logsDir(dir), exitDir(dir)]) {
    mkdirSync(one, { recursive: true, mode: 0o700 })
    try {
      chmodSync(one, 0o700)
    } catch {
      /* Not ours to change: it is still only used by us. */
    }
  }
}

/**
 * The CLI's token: 32 random bytes, in a file only this user can read. A program that can read it
 * runs as this user on this machine, which could run the command itself; a web page cannot read it.
 * Made once and kept, so a CLI waiting through a restart of this module still gets in.
 */
export function cliToken(dir: string): string {
  ensureDirs(dir)
  const file = join(dir, TOKEN_FILE)
  if (existsSync(file)) {
    const kept = readFileSync(file, 'utf8').trim()
    if (/^[A-Za-z0-9_-]{32,128}$/.test(kept)) {
      chmodSync(file, 0o600)
      return kept
    }
  }
  const token = randomBytes(32).toString('base64url')
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}
