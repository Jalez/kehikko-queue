import { LIMITS, footerItemsSchema, type FooterItem } from 'kehikot-module-protocol'

import type { RunView } from '../queue/queue.ts'
import type { LeaseView } from '../queue/leases.ts'
import { whoAsked } from '../queue/who.ts'
import { counts, holding, loadAgainst, queueLine, queueNow, queueSaid, recentResults, resultsSaid, strainSaid } from './glance.ts'
import type { Machine } from './wire/api.ts'

/**
 * Queue's footer, in a host that draws one (`kehikot.footer`, protocol 2.38.0): what is going on
 * now, in words, so a container folded to its header and footer still says it. The header holds
 * nothing (the scope is the person's, in the settings window); every item here is a readout, so
 * nothing is pressable.
 *
 * - the queue: how many are waiting, and how many running (of the most at once, in its tooltip);
 * - the load against the limit above which new runs wait, a meter, critical while it holds runs;
 * - the latest results, in words, warn when one failed;
 * - what went wrong reading the queue, when it did.
 *
 * Pure: the page declares it (only when `drawsFooter` is true), the tests read it.
 */
export interface FooterState {
  runs: readonly RunView[]
  machine: Machine | null
  /** What went wrong reading or changing the queue, or null. */
  trouble: string | null
  /** The dev-server leases, when the server tells them. */
  leases?: readonly LeaseView[]
}

/** The waiting runs in line, each with who asked: "#1 bun test — Claude Code (session 9186314e)". */
export function lineSaid(runs: readonly RunView[]): string {
  return runs
    .filter((run) => run.state === 'queued')
    .map((run) => `#${run.position ?? '?'} ${run.label} — ${whoAsked(run.asker)}`)
    .join('; ')
}

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text)

export function footerItems({ runs, machine, trouble, leases = [] }: FooterState): FooterItem[] {
  const items: unknown[] = []
  if (trouble) items.push({ kind: 'text', id: 'trouble', text: cut(trouble, LIMITS.FOOTER_TEXT), level: 'critical', tooltip: cut(trouble, LIMITS.FOOTER_TOOLTIP) })
  if (!machine) {
    if (!trouble) items.push({ kind: 'text', id: 'queue', text: 'Reading the queue…' })
    return footerItemsSchema.parse(items)
  }
  const now = queueNow(runs, machine)
  items.push({
    kind: 'text',
    id: 'queue',
    text: queueLine(now),
    tooltip: cut(now.waiting ? `${queueSaid(now)} In line: ${lineSaid(runs)}.` : queueSaid(now), LIMITS.FOOTER_TOOLTIP),
  })
  const leased = leases.filter((lease) => lease.state === 'running')
  if (leased.length) {
    items.push({
      kind: 'text',
      id: 'leases',
      text: `${leased.length}${machine.leasesMost !== undefined ? ` of ${machine.leasesMost}` : ''} dev server${leased.length === 1 ? '' : 's'}`,
      optional: true,
      tooltip: cut(leased.map((lease) => `${lease.label} on port ${lease.port}, leased by ${whoAsked(lease.asker)}`).join('; '), LIMITS.FOOTER_TOOLTIP),
    })
  }
  const held = holding(machine)
  const share = machine.loadAbove > 0 ? Math.min(1, Math.max(0, machine.load / machine.loadAbove)) : 1
  items.push({
    kind: 'meter',
    id: 'load',
    label: 'Load',
    value: share,
    text: cut(`${loadAgainst(machine)}${held ? ' held' : ''}`, LIMITS.FOOTER_METER_TEXT),
    level: held ? 'critical' : share >= 0.8 ? 'warn' : 'normal',
    align: 'center',
    tooltip: cut(strainSaid(machine, machine.samples ?? []), LIMITS.FOOTER_TOOLTIP),
  })
  const results = recentResults(runs)
  if (results.length) {
    const n = counts(results)
    items.push({
      kind: 'text',
      id: 'results',
      text: `${n.passed} passed · ${n.failed} failed${n.cancelled ? ` · ${n.cancelled} cancelled` : ''}`,
      level: n.failed ? 'warn' : 'normal',
      align: 'end',
      optional: true,
      tooltip: cut(resultsSaid(results), LIMITS.FOOTER_TOOLTIP),
    })
  }
  return footerItemsSchema.parse(items)
}
