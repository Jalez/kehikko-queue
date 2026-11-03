import { describe, expect, test } from 'bun:test'

import { inboxItems, itemIdOf, runIdOf } from '../src/inbox.ts'
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
      ['run:r1', 'attention', 'Tests failed: pre-push monorepo in p (exit 3)'],
      ['run:r2', 'done', 'Tests passed: pre-push monorepo in p'],
      ['run:r3', 'working', 'Tests running: pre-push monorepo in p'],
      ['run:r4', 'working', 'Tests waiting: pre-push monorepo in p'],
    ])
    expect(items[0]).toMatchObject({ project: '/p', place: { epic: 'queue' }, refs: ['!3907'], priority: 'normal' })
    expect(items[0]!.detail).toContain('pre-push hook')
  })
  test('a failure says which run it is: its label, where it ran, who started it, and the epic it came from', () => {
    const origin = { project: '/p', projectId: 'pid', projectName: 'P', epic: 'auth', parts: ['login'], kehikko: 'k-wide', kehikkoName: 'Wide', session: 's1', branch: 'fix/login' }
    const [item] = inboxItems([aRun({ cwd: '/p-worktrees/fix-login', origin, asker: { via: 'mcp', said: 'an agent session (bd462ecd) in P › auth on "Wide".', token: null, conversation: null } })], 4000)
    expect(item!.label).toBe('Tests failed: pre-push monorepo on fix/login (exit 3)')
    expect(item!.detail).toBe('Started by an agent session (bd462ecd) in P › auth on "Wide". Ran in /p-worktrees/fix-login on branch fix/login. Open it to see its output in Test runs.')
    /* Not the kehikko it was asked from: that one may have no Test runs, and opening the item has to show the run. */
    expect(item!.place).toEqual({ epic: 'auth', parts: ['login'] })
  })
  test('a place the protocol would refuse falls back to the epic, never failing the list', () => {
    const origin = { project: '/p', projectId: null, projectName: null, epic: 'auth', parts: ['Not A Slug'], kehikko: null, kehikkoName: null, session: null, branch: null }
    expect(inboxItems([aRun({ origin })], 4000)[0]!.place).toEqual({ epic: 'auth' })
  })
  test('a failure the person has been shown leaves the Inbox; one not yet shown stays', () => {
    const items = inboxItems([aRun({ id: 'seen', seenAt: 3500 }), aRun({ id: 'not' })], 4000)
    expect(items.map((one) => one.id)).toEqual(['run:not'])
  })
  test('an expected red is done, never attention; an expected red that passed asks', () => {
    const items = inboxItems([aRun({ id: 'red', expect: 'fail' }), aRun({ id: 'surprise', expect: 'fail', state: 'passed', exit: 0 })], 4000)
    expect(items.map((one) => [one.id, one.state, one.priority, one.label])).toEqual([
      ['run:red', 'done', 'low', 'Tests failed as expected: pre-push monorepo in p (exit 3)'],
      ['run:surprise', 'attention', 'normal', 'Tests passed but were expected to fail: pre-push monorepo in p'],
    ])
  })
  test('a failure the session that asked has read is low, not normal, and says so', () => {
    const [item] = inboxItems([aRun({ askerToldAt: 3500 })], 4000)
    expect(item).toMatchObject({ state: 'attention', priority: 'low' })
    expect(item!.detail).toContain('The session that asked for it has read the result.')
  })
  test('a superseded failure leaves the Inbox', () => {
    expect(inboxItems([aRun({ seenAt: 3500, supersededBy: 'r2' })], 4000)).toEqual([])
  })
  test('item ids and run ids go both ways', () => {
    expect(itemIdOf('r1')).toBe('run:r1')
    expect(runIdOf('run:r1')).toBe('r1')
    expect(runIdOf('run:')).toBeNull()
    expect(runIdOf('other')).toBeNull()
  })
  test('a run from no project, or older than a day, is not in it', () => {
    expect(inboxItems([aRun({ project: null }), aRun({ id: 'old', finishedAt: 0 })], 2 * 86_400_000)).toEqual([])
  })
})
