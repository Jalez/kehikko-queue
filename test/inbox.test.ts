import { describe, expect, test } from 'bun:test'

import { inboxItems } from '../src/inbox.ts'
import type { RunView } from '../queue/queue.ts'

export function aRun(over: Partial<RunView> = {}): RunView {
  return {
    id: 'r1',
    label: 'pre-push monorepo',
    kind: 'push',
    refs: ['!3907'],
    epic: 'queue',
    project: '/p',
    argv: ['bun', 'test'],
    cwd: '/p',
    asker: { via: 'cli', said: 'pre-push hook, in /p', token: null, conversation: null },
    origin: null,
    state: 'failed',
    why: null,
    pri: 0,
    rank: 1,
    queuedAt: 1000,
    startedAt: 2000,
    finishedAt: 3000,
    exit: 3,
    pid: null,
    overdue: false,
    position: null,
    waiting: null,
    ...over,
  }
}

describe('the Inbox', () => {
  test('a failure needs the person; a pass is done; a waiting or running run is working', () => {
    const items = inboxItems([aRun(), aRun({ id: 'r2', state: 'passed', exit: 0 }), aRun({ id: 'r3', state: 'running', finishedAt: null, exit: null }), aRun({ id: 'r4', state: 'queued', startedAt: null, finishedAt: null, exit: null })], 4000)
    expect(items.map((one) => [one.id, one.state, one.label])).toEqual([
      ['run:r1', 'attention', 'Tests failed: pre-push monorepo (exit 3)'],
      ['run:r2', 'done', 'Tests passed: pre-push monorepo'],
      ['run:r3', 'working', 'Tests running: pre-push monorepo'],
      ['run:r4', 'working', 'Tests waiting: pre-push monorepo'],
    ])
    expect(items[0]).toMatchObject({ project: '/p', place: { epic: 'queue' }, refs: ['!3907'], priority: 'normal' })
    expect(items[0]!.detail).toContain('pre-push hook')
  })
  test('a run from no project, or older than a day, is not in it', () => {
    expect(inboxItems([aRun({ project: null }), aRun({ id: 'old', finishedAt: 0 })], 2 * 86_400_000)).toEqual([])
  })
})
