import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import { KEHIKOT_DIR, moduleDir, moduleFile, type RunResult } from 'kehikot-module-protocol'
import { writeRuns } from 'kehikot-module-protocol/serve'

import { ID } from './manifest.ts'

/**
 * The only thing this module writes into a project: the runs it holds for that project, published as
 * the protocol's run results (2.27.0), `<project>/.kehikot/queue/runs.json`, so any module showing a
 * change or an issue can show whether its tests pass without knowing this module exists. Everything
 * else — the queue itself, the logs — is machine state (`queue/machine.ts`).
 *
 * Written only into a folder that is already a Kehikot project (it has `.kehikot/`): a run from a
 * folder nobody opened in Kehikot is still run, it only has nowhere to be shown. The folder gets a
 * `.gitignore` of its own, because a run result is this machine's news and not the project's history.
 */
export const RUNS_IGNORE = '# Test runs on this computer: not the project\'s history.\nruns.json\nruns.json.*\n'

export function isProject(path: string | null | undefined): path is string {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  try {
    return statSync(join(path, KEHIKOT_DIR)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The Kehikot project a working folder belongs to: the folder itself, or the main checkout of the
 * git repository it is a worktree or a subfolder of, when that is a project. Null for none.
 */
export function projectOf(cwd: string): string | null {
  let real: string
  try {
    real = realpathSync(cwd)
  } catch {
    return null
  }
  /* Up the folders first: a subfolder of a project is in it. */
  for (let at = real; ; at = dirname(at)) {
    if (isProject(at)) return at
    if (dirname(at) === at) break
  }
  /* A worktree elsewhere: its main checkout, by the repository's common folder. */
  const asked = spawnSync('git', ['-C', real, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
  if (asked.status !== 0) return null
  const common = (asked.stdout ?? '').trim()
  if (!common.endsWith('/.git')) return null
  const main = dirname(common)
  return isProject(main) ? main : null
}

/** Publish one project's runs, whole. Never throws: a project that cannot be written is said, not fatal. */
export function publish(projectPath: string, runs: readonly RunResult[]): string | null {
  try {
    if (!isProject(projectPath)) return null
    writeRuns(projectPath, ID, runs)
    const dir = moduleDir(projectPath, ID)
    const ignore = dir ? join(dir, '.gitignore') : null
    if (ignore && (!existsSync(ignore) || readFileSync(ignore, 'utf8') !== RUNS_IGNORE)) writeFileSync(ignore, RUNS_IGNORE)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Where a project's run results are, for the words. */
export const runsFileOf = (projectPath: string) => moduleFile(projectPath, ID, 'runs')
