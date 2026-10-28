/**
 * Where a run came from, as far as was known when it was asked for: only what a jump needs. Never
 * the environment, never the place token (that is `Asker.token`, for cancelling). Pure: the page
 * and the server both read it.
 */
export interface Origin {
  /** The Kehikot project's folder. */
  project: string
  projectName: string | null
  epic: string | null
  /** Ids of the parts picked, as `context.parts` spells them. Empty: the whole epic. */
  parts: string[]
  /** The kehikko's key, and its name for the words. */
  kehikko: string | null
  kehikkoName: string | null
  /** The agent session that asked, when the caller was one. Kept for when a host can show it. */
  session: string | null
  /** The branch checked out in the folder it ran in, when that is a git repository. */
  branch: string | null
}

export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

/** What a `view.goto` asks. `epic` always: the protocol takes `parts` and `kehikko` only with one. */
export interface GotoParams {
  epic: string
  parts?: string[]
  kehikko?: string
}

export interface Jump {
  /** The call, or null when the button is disabled. */
  goto: GotoParams | null
  /** The tooltip: where it goes, or why it cannot. */
  words: string
}

export interface JumpRun {
  cwd: string
  project: string | null
  epic: string | null
  origin?: Origin | null
}

/** A run kept before origins were recorded knows its project and epic, and nothing more. */
export function originOf(run: JumpRun): Origin | null {
  if (run.origin) return run.origin
  if (!run.project) return null
  return { project: run.project, projectName: null, epic: run.epic, parts: [], kehikko: null, kehikkoName: null, session: null, branch: null }
}

/**
 * What the jump-into button does for a run. `openProject` is the project the host has open (null
 * when the page is not framed); `partName` turns a part id into the words the person knows it by.
 *
 * `view.goto` moves within the project the host has open: it carries no project. So a run from
 * another project cannot be jumped to from here, and the button says which one to open.
 */
export function jumpFor(run: JumpRun, openProject: string | null, partName: (id: string) => string = (id) => id): Jump {
  const origin = originOf(run)
  if (!origin) return { goto: null, words: `Started outside any Kehikot project: ${baseName(run.cwd)}` }
  const name = origin.projectName ?? baseName(origin.project)
  if (!openProject) return { goto: null, words: `Open Test runs in Kehikot to go to ${name}.` }
  if (origin.project !== openProject) return { goto: null, words: `This run came from ${name}. Open that project in Kehikot, then go to it from there.` }
  if (!origin.epic) return { goto: null, words: `Started in ${name} but not in an epic, so there is no place to go to.` }
  const parts = origin.parts.map(partName)
  const where = [origin.kehikkoName, origin.epic, parts.length ? parts.join(', ') : null].filter(Boolean).join(' · ')
  return {
    goto: { epic: origin.epic, ...(origin.parts.length ? { parts: origin.parts } : {}), ...(origin.kehikko ? { kehikko: origin.kehikko } : {}) },
    words: `Go to ${where}`,
  }
}
