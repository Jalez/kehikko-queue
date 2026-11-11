import { WORK_QUEUE, workQueueSchema, type WorkKind, type WorkQueue } from 'kehikot-module-protocol'

import { shellQuoted } from './guards.ts'
import type { Kind } from './kinds.ts'
import { WRAPPER } from './runner.ts'

/**
 * What this module provides to other modules (protocol 2.81.0, `services`): `work.queue`, the descriptor
 * a consumer reads through the host to tell a session how to hand heavy work to the queue — and that
 * agent modules can read for a guard's or a restart note's words. This module's program path, its tool
 * and its words are said here and nowhere in a consumer.
 */

/** Each kind of heavy work the protocol names, as the kind this queue runs it under. */
export const WORK_KIND_AS: Record<WorkKind, Kind> = { test: 'verify', typecheck: 'typecheck', build: 'build', install: 'task' }

/**
 * What this queue wants handed to it when a session starts it on its own (protocol 2.86.0, `wants`), so a
 * consumer watching processes flags only that: whole test suites at 50% of a core for 15 s, typechecks and
 * builds at 80% for 10 s. Installs are left out: network-bound and quick, they are not flagged.
 */
export const WANTS = {
  test: { minCpu: 50, sustainedSeconds: 15, wholeSuiteOnly: true },
  typecheck: { minCpu: 80, sustainedSeconds: 10 },
  build: { minCpu: 80, sustainedSeconds: 10 },
} as const

/** The `work.queue` descriptor, for the CLI at `cli` (its absolute path, quoted into each run line). */
export function workQueueFor(cli: string): WorkQueue {
  const run = shellQuoted(cli)
  return workQueueSchema.parse({
    name: 'Queue',
    run: Object.fromEntries(Object.entries(WORK_KIND_AS).map(([work, kind]) => [work, `${run} run --kind ${kind} -- {command}`])),
    cli,
    tool: 'queue_run',
    direct: 'KEHIKOT_DIRECT=1',
    /* A run's process sits under the runner's wrapper line; the CLI waits on one (and runs it itself when the queue is away). */
    marks: [WRAPPER, 'kehikot-queue'],
    wants: WANTS,
  })
}

/** `services` for the manifest. */
export const servicesFor = (cli: string) => ({ [WORK_QUEUE]: workQueueFor(cli) })
