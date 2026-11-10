import type { Asker } from './queue.ts'

/* Pure: the page, the footer and the doors read it. */

/** Who asked, in a few words a person reads in a list: the agent and its session, or what the asker said. */
export function whoAsked(asker: Asker): string {
  const session = asker.session ? `session ${asker.session.slice(0, 8)}` : asker.conversation ? `session ${asker.conversation.slice(0, 8)}` : null
  if (asker.agent && session) return `${asker.agent} (${session})`
  if (asker.agent) return asker.agent
  if (session) return session
  return asker.said.replace(/, in \/.*$/, '')
}

/** Who asked, whole, for a run's details: the agent and its session first when known, then where from. */
export function askedSaid(asker: Asker): string {
  return asker.agent || asker.session ? `${whoAsked(asker)}, ${asker.said}` : asker.said
}
