import { describe, expect, test } from 'bun:test'
import { WORK_QUEUE, providerOf, serviceDescriptor, workQueueSaid, workQueueSchema } from 'kehikot-module-protocol'

import { MANIFEST } from '../doors.ts'
import { CLI } from '../skills.ts'
import { WRAPPER } from '../queue/runner.ts'
import { WORK_KIND_AS, workQueueFor } from '../queue/service.ts'
import { RUN_KINDS } from '../queue/kinds.ts'

/* Protocol 2.81.0: Queue provides `work.queue`, and a consumer builds its words from this descriptor only. */
describe('the work.queue service', () => {
  test('the declaration validates against the protocol’s schema, and the served manifest carries it', () => {
    const served = (MANIFEST as { services?: Record<string, unknown> }).services?.[WORK_QUEUE]
    expect(workQueueSchema.safeParse(served).success).toBe(true)
    expect(serviceDescriptor(WORK_QUEUE, served)).toEqual(workQueueFor(CLI))
  })

  test('each kind of work goes in as a kind this queue runs, with this install’s CLI quoted', () => {
    const queue = workQueueFor('/Users/p/Library/Application Support/Kehikot/installed/x/bin/kehikot-queue')
    for (const kind of Object.values(WORK_KIND_AS)) expect(RUN_KINDS).toContain(kind)
    expect(queue.run.test).toBe("'/Users/p/Library/Application Support/Kehikot/installed/x/bin/kehikot-queue' run --kind verify -- {command}")
    expect(queue.run.install).toContain('--kind task -- {command}')
    expect(queue.marks).toContain(WRAPPER)
    expect(queue.tool).toBe('queue_run')
  })

  test('what a consumer would say, read through a services.find answer', () => {
    const found = providerOf(WORK_QUEUE, [{ module: 'kehikot.queue', name: 'Queue', descriptor: workQueueFor('/q/bin/kehikot-queue'), placed: null }])
    expect(workQueueSaid(found!.descriptor, 'typecheck', 'tsc --noEmit')).toBe('Run it through Queue: `/q/bin/kehikot-queue run --kind typecheck -- tsc --noEmit` from the same folder, or with the queue_run tool.')
  })
})
