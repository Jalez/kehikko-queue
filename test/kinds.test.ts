import { describe, expect, test } from 'bun:test'

import { kindOf } from '../queue/asks.ts'
import { kindSaid, publishedKind, RUN_KINDS } from '../queue/kinds.ts'
import { tools } from '../doors.ts'

describe('the kinds of run', () => {
  test('tests, builds and other heavy commands; a run without a kind is tests', () => {
    expect(RUN_KINDS).toEqual(expect.arrayContaining(['verify', 'build', 'task', 'push', 'review', 'other']))
    expect(kindOf(undefined)).toEqual({ ok: true, value: 'verify' })
    expect(kindOf('build')).toEqual({ ok: true, value: 'build' })
    expect(kindOf('task')).toEqual({ ok: true, value: 'task' })
    expect(kindOf('other')).toEqual({ ok: true, value: 'other' })
    const refused = kindOf('deploy')
    expect(refused.ok).toBe(false)
  })
  test('said in a person\'s words; other is said as a task', () => {
    expect(['verify', 'build', 'task', 'other', 'later'].map(kindSaid)).toEqual(['tests', 'build', 'task', 'task', 'task'])
  })
  test('published in the protocol\'s kinds: a build or a task is other', () => {
    expect(RUN_KINDS.map(publishedKind)).toEqual(['verify', 'other', 'other', 'push', 'review', 'other', 'verify', 'verify'])
  })
  test('queue_run offers every kind and says builds and other heavy work belong in it', () => {
    const run = tools().find((one) => one.name === 'queue_run')!
    expect((run.inputSchema.properties as Record<string, { enum?: string[] }>).kind!.enum).toEqual([...RUN_KINDS])
    expect(run.description).toContain('a build')
  })
})
