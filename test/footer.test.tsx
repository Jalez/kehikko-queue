import { afterEach, describe, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

import { Screen } from '../src/app.tsx'
import { footerItems } from '../src/footer.ts'
import { streams } from './streams.ts'
import type { Api } from '../src/wire/api.ts'
import type { Host } from '../src/wire/use-kehikot.ts'
import { aRun } from './inbox.test.ts'

afterEach(cleanup)

const machine = { cores: 12, load: 3.2, most: 2, loadAbove: 9, waitMinutes: 10 }

describe('the footer', () => {
  test('says running, waiting, load and the latest results in words; nothing pressable', () => {
    const runs = [
      aRun({ id: 'w1', state: 'queued', startedAt: null, finishedAt: null, exit: null, position: 1 }),
      aRun({ id: 'u1', state: 'running', finishedAt: null, exit: null }),
      aRun({ id: 'f1', state: 'failed' }),
      aRun({ id: 'p1', state: 'passed', exit: 0 }),
    ]
    const items = footerItems({ runs, machine, trouble: null })
    expect(items.find((i) => i.id === 'queue')).toMatchObject({ kind: 'text', text: '1 waiting · 1 running' })
    expect(items.find((i) => i.id === 'load')).toMatchObject({ kind: 'meter', label: 'Load', text: '3.2 / 9.0', level: 'normal' })
    expect(items.find((i) => i.id === 'results')).toMatchObject({ kind: 'text', text: '1 passed · 1 failed', level: 'warn', optional: true })
    expect(items.every((i) => i.kind === 'text' || i.kind === 'meter')).toBe(true)
  })

  test('the queue\'s tooltip says each waiting run\'s place in line and who asked; leased dev servers are an item', () => {
    const runs = [aRun({ id: 'w1', label: 'tsc', state: 'queued', startedAt: null, finishedAt: null, exit: null, position: 1, asker: { via: 'cli', said: 'a shell, in /p', token: null, conversation: null, agent: 'Claude Code', session: 'abcdef123456' } })]
    const lease = { id: 'l1', label: 'app: bun run dev', argv: ['bun', 'run', 'dev'], cwd: '/p', project: null, port: 5281, asker: { via: 'cli' as const, said: 'a shell, in /p', token: null, conversation: null, session: 'abcdef123456' }, sessionPid: null, startedAt: 0, until: 1, pid: 1, state: 'running' as const, endedAt: null, why: null, exit: null }
    const items = footerItems({ runs, machine: { ...machine, leasesMost: 3 }, trouble: null, leases: [lease] })
    expect(items.find((i) => i.id === 'queue')!.tooltip).toContain('#1 tsc — Claude Code (session abcdef12)')
    expect(items.find((i) => i.id === 'leases')).toMatchObject({ kind: 'text', text: '1 of 3 dev server', tooltip: 'app: bun run dev on port 5281, leased by session abcdef12' })
  })

  test('a load above the limit is critical and says held; no results yet, no results item', () => {
    const items = footerItems({ runs: [], machine: { ...machine, load: 10 }, trouble: null })
    expect(items.find((i) => i.id === 'load')).toMatchObject({ value: 1, level: 'critical', text: '10.0 / 9.0 held' })
    expect(items.some((i) => i.id === 'results')).toBe(false)
    expect(items.find((i) => i.id === 'queue')).toMatchObject({ text: 'none waiting · 0 running' })
  })

  test('before the first read it says so; trouble is critical', () => {
    expect(footerItems({ runs: [], machine: null, trouble: null })).toEqual([expect.objectContaining({ id: 'queue', text: 'Reading the queue…' })])
    expect(footerItems({ runs: [], machine: null, trouble: 'The queue did not answer.' })[0]).toMatchObject({ id: 'trouble', level: 'critical' })
  })
})

describe('the page and the footer', () => {
  const host = (over: Partial<Host> = {}): Host => ({
    where: 'hosted',
    project: 'p',
    projectPath: '/p',
    projectId: null,
    epic: 'queue',
    parts: [],
    theme: 'light',
    header: () => {},
    activity: () => {},
    request: async () => ({}),
    picked: [],
    ...over,
  })
  const overview = { runs: [aRun({ id: 'p1', state: 'passed', exit: 0 })], machine }
  const api: Api = {
    ...streams().api,
    runs: async () => overview,
    output: async () => ({ text: '', next: 0, size: 0 }),
    cancel: async () => overview,
    move: async () => overview,
    release: async () => overview,
  }
  const settle = () => act(async () => new Promise((done) => setTimeout(done, 20)))

  test('declares the footer only when the host draws one', async () => {
    const said: unknown[][] = []
    render(<Screen host={host({ drawsFooter: true, footer: (items) => void said.push(items) })} api={api} now={() => 5000} />)
    await settle()
    expect(said.at(-1)).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'queue', text: 'none waiting · 0 running' })]))
    cleanup()
    const none: unknown[][] = []
    render(<Screen host={host({ drawsFooter: false, footer: (items) => void none.push(items) })} api={api} now={() => 5000} />)
    await settle()
    expect(none).toHaveLength(0)
  })
})
