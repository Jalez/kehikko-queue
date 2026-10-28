/**
 * Where a run came from, as far as was known when it was asked for: only what a jump needs. Never
 * the environment, never the place token (that is `Asker.token`, for cancelling). Pure: the page
 * and the server both read it.
 */
export interface Origin {
  /** The Kehikot project's folder. */
  project: string
  /**
   * The project's permanent id (`context.projectId`), when the host said it: what a jump names the
   * project by, so a renamed folder is still found. Absent from a run kept by 0.2.0: the folder then.
   */
  projectId?: string | null
  projectName: string | null
  epic: string | null
  /** Ids of the parts picked, as `context.parts` spells them. Empty: the whole epic. */
  parts: string[]
  /** The kehikko's key, and its name for the words. */
  kehikko: string | null
  kehikkoName: string | null
  /** The agent session that asked, when the caller was one: shown on arrival (`view.goto { show }`). */
  session: string | null
  /** The branch checked out in the folder it ran in, when that is a git repository. */
  branch: string | null
}

export const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

/**
 * What a `view.goto` asks. `epic` always: the protocol takes `parts`, `kehikko` and `project` only
 * with one. `project` (protocol 2.28.0) is the project's id, else its folder; `show` the agent session
 * that asked, for the module on that kehikko that runs it.
 */
export interface GotoParams {
  epic: string
  parts?: string[]
  kehikko?: string
  project?: string
  show?: { subject: 'agent-session'; id: string }
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

/** The project the host has open, as the page's context names it. */
export interface OpenProject {
  path: string | null
  id: string | null
}

/**
 * What the jump-into button does for a run. `open` is the project the host has open (null when the
 * page is not framed); `partName` turns a part id into the words the person knows it by.
 *
 * Since protocol 2.28.0 `view.goto` carries `project`: a run from another project is jumped to by the
 * host switching project first, and the tooltip names that project. The session that asked goes as
 * `show`, so the module running it shows it there.
 */
export function jumpFor(run: JumpRun, open: OpenProject | string | null, partName: (id: string) => string = (id) => id): Jump {
  const origin = originOf(run)
  if (!origin) return { goto: null, words: `Started outside any Kehikot project: ${baseName(run.cwd)}` }
  const name = origin.projectName ?? baseName(origin.project)
  const here = typeof open === 'string' ? { path: open, id: null } : open
  if (!here || (!here.path && !here.id)) return { goto: null, words: `Open Test runs in Kehikot to go to ${name}.` }
  if (!origin.epic) return { goto: null, words: `Started in ${name} but not in an epic, so there is no place to go to.` }
  const elsewhere = !(origin.projectId && here.id ? origin.projectId === here.id : origin.project === here.path)
  const parts = origin.parts.map(partName)
  const where = [elsewhere ? name : null, origin.kehikkoName, origin.epic, parts.length ? parts.join(', ') : null].filter(Boolean).join(' · ')
  return {
    goto: {
      epic: origin.epic,
      ...(origin.parts.length ? { parts: origin.parts } : {}),
      ...(origin.kehikko ? { kehikko: origin.kehikko } : {}),
      ...(elsewhere ? { project: origin.projectId || origin.project } : {}),
      ...(origin.session ? { show: { subject: 'agent-session' as const, id: origin.session } } : {}),
    },
    words: `Go to ${where}${elsewhere ? ' (in another project)' : ''}`,
  }
}
