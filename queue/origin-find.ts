import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'

import type { DoorPlace } from 'kehikot-module-protocol'
import { hostProject, type HostHasProjectOptions } from 'kehikot-module-protocol/serve'

import { baseName, type Origin } from './origin.ts'

/** The branch checked out in `cwd`, or null when it is not a git repository or has none (a detached head). */
export function branchOf(cwd: string): string | null {
  const asked = spawnSync('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
  const branch = (asked.stdout ?? '').trim()
  return asked.status === 0 && branch ? branch.slice(0, 120) : null
}

/** The place a token names, as an origin: project, epic, picked parts, kehikko, and the session. */
export function originFromPlace(place: DoorPlace, cwd: string | null): Origin {
  return {
    project: place.project,
    projectName: place.projectName ?? null,
    epic: place.epic,
    parts: [...place.parts],
    kehikko: place.kehikko?.key ?? null,
    kehikkoName: place.kehikko?.name ?? null,
    session: place.conversation ?? null,
    branch: cwd ? branchOf(cwd) : null,
  }
}

/** The folders a working folder could be a project through: itself and each folder above, then a worktree's main checkout. */
function candidates(cwd: string): string[] {
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
  const common = spawnSync('git', ['-C', real, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
  const folder = (common.stdout ?? '').trim()
  if (common.status === 0 && folder.endsWith('/.git')) out.push(dirname(folder))
  return out
}

/**
 * The origin of a run with no place: the project the HOST says `cwd` is (or is inside), found by
 * asking about each folder from `cwd` upward. Null when none is: a hook run outside Kehikot.
 */
export async function originFromCwd(cwd: string, epic: string | null, options: HostHasProjectOptions = {}): Promise<Origin | null> {
  for (const folder of candidates(cwd)) {
    const said = await hostProject(folder, options)
    if (said.project) {
      return { project: said.path, projectName: baseName(said.path), epic, parts: [], kehikko: null, kehikkoName: null, session: null, branch: branchOf(cwd) }
    }
  }
  return null
}
