import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'

import type { DoorPlace } from 'kehikot-module-protocol'
import { hostProject, type HostHasProjectOptions } from 'kehikot-module-protocol/serve'

import { baseName, type Origin } from './origin.ts'

/**
 * One git question, answered without holding the server: what it printed, or null when it failed or
 * took longer than 5 s. Never `spawnSync`: on a machine busy with the very runs this module queues,
 * a synchronous git held the event loop, and every door (the settings, the page, the CLI) waited behind it.
 */
function git(args: string[]): Promise<string | null> {
  return new Promise((done) => {
    try {
      execFile('git', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => done(error ? null : String(stdout)))
    } catch {
      done(null)
    }
  })
}

/** The branch checked out in `cwd`, or null when it is not a git repository or has none (a detached head). */
export async function branchOf(cwd: string): Promise<string | null> {
  const branch = ((await git(['-C', cwd, 'symbolic-ref', '--short', 'HEAD'])) ?? '').trim()
  return branch ? branch.slice(0, 120) : null
}

/** The place a token names, as an origin: project, epic, picked parts, kehikko, and the session. */
export async function originFromPlace(place: DoorPlace, cwd: string | null): Promise<Origin> {
  return {
    project: place.project,
    projectId: place.projectId,
    projectName: place.projectName ?? null,
    epic: place.epic,
    parts: [...place.parts],
    kehikko: place.kehikko?.key ?? null,
    kehikkoName: place.kehikko?.name ?? null,
    session: place.conversation ?? null,
    branch: cwd ? await branchOf(cwd) : null,
  }
}

/** The folders a working folder could be a project through: itself and each folder above, then a worktree's main checkout. */
async function candidates(cwd: string): Promise<string[]> {
  let real: string
  try {
    real = realpathSync(cwd)
  } catch {
    return []
  }
  const out: string[] = []
  for (let at = real; ; at = dirname(at)) {
    out.push(at)
    if (dirname(at) === at) break
  }
  const folder = ((await git(['-C', real, 'rev-parse', '--path-format=absolute', '--git-common-dir'])) ?? '').trim()
  if (folder.endsWith('/.git')) out.push(dirname(folder))
  return out
}

/**
 * The origin of a run with no place: the project the HOST says `cwd` is (or is inside), found by
 * asking about each folder from `cwd` upward. Null when none is: a hook run outside Kehikot.
 */
export async function originFromCwd(cwd: string, epic: string | null, options: HostHasProjectOptions = {}): Promise<Origin | null> {
  for (const folder of await candidates(cwd)) {
    const said = await hostProject(folder, options)
    if (said.project) {
      return { project: said.path, projectId: said.id ?? null, projectName: baseName(said.path), epic, parts: [], kehikko: null, kehikkoName: null, session: null, branch: await branchOf(cwd) }
    }
  }
  return null
}
