import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { Glance } from '../src/components/glance.tsx'
import { footerItems } from '../src/footer.ts'
import { CHART_HINTS, loadAgainst, loadTip, strainSaid } from '../src/glance.ts'
import { Screen, SETTINGS_WHERE } from '../src/app.tsx'
import { settingsFor } from '../queue/fields.ts'
import { autoLoad, LOAD_KEY, loadLimitSaid, loadText, MOST_KEY } from '../queue/load.ts'
import { capacityOf, migrateValues, readValues, SETTINGS, valuesOf, writeValue } from '../queue/settings.ts'
import type { Api, Machine } from '../src/wire/api.ts'
import type { Host } from '../src/wire/use-kehikot.ts'
import { streams } from './streams.ts'

/*
 * One unit for the load limit everywhere (the load itself, as the chart draws it), and pressing a
 * chart opens the setting it is about (`settings.open`, protocol 2.90.0).
 */

afterEach(cleanup)

const scratch = () => mkdtempSync(join(tmpdir(), 'queue-load-'))
const machine: Machine = { cores: 8, load: 6.25, most: 2, loadAbove: 6, waitMinutes: 10, samples: [{ at: 0, load: 1.5 }, { at: 60_000, load: 6.25 }] }

describe('the load limit is the load itself', () => {
  test('the setting is the absolute load, 0 is Queue deciding, and says the cores', () => {
    const field = settingsFor(8).find((one) => one.key === LOAD_KEY)!
    expect(field).toMatchObject({ label: 'Pause new runs above load', type: 'number', default: 0 })
    expect(field.description).toContain('8 cores')
    expect(field.description).toContain('0 lets Queue decide: 6 here')
    expect(field.description).toContain('Load chart')
    expect(SETTINGS.some((one) => one.key === 'load')).toBe(false)
  })

  test('a set limit is the chart\'s limit, unchanged', () => {
    expect(capacityOf({ [LOAD_KEY]: 6 }, 8).loadAbove).toBe(6)
    expect(capacityOf({ [LOAD_KEY]: 0 }, 8).loadAbove).toBe(autoLoad(8))
    expect(capacityOf({}, 12).loadAbove).toBe(9)
  })

  test('written and refused in the same unit', () => {
    const dir = scratch()
    expect(writeValue(dir, LOAD_KEY, 6)).toBeNull()
    expect(capacityOf(readValues(dir), 8).loadAbove).toBe(6)
    expect(writeValue(dir, LOAD_KEY, -1)).toContain('a load from 0 to 1024')
    expect(writeValue(dir, 'load', 0.75)).toBe('There is no such setting.')
  })

  test('a limit kept per core becomes the load on this computer, once', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ load: 0.75, most: 3 }))
    expect(migrateValues(dir, 8)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ most: 3, [LOAD_KEY]: 6 })
    expect(migrateValues(dir, 8)).toBe(false)
  })

  test('a limit already in the new unit is kept over the old one', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ load: 0.5, [LOAD_KEY]: 7 }))
    migrateValues(dir, 8)
    expect(readValues(dir)).toEqual({ [LOAD_KEY]: 7 })
  })

  test('the values are answered from memory, and a change is seen at once', () => {
    const dir = scratch()
    expect(valuesOf(dir)).toEqual({})
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ most: 9 }))
    expect(valuesOf(dir)).toEqual({}) /* by hand: read at the next start */
    expect(writeValue(dir, 'most', 4)).toBeNull()
    expect(valuesOf(dir)).toEqual({ most: 4 })
  })

  test('the chart, its tooltip, the tile, the footer and the setting say the same numbers', () => {
    expect(loadText(9)).toBe('9')
    expect(loadText(6.25)).toBe('6.3')
    expect(loadAgainst(machine)).toBe('6.3 / 6')
    expect(loadLimitSaid(6, 8)).toBe('Pause new runs when the load is above 6 (of 8 cores)')
    expect(strainSaid(machine, [])).toBe('Load 6.3. Pause new runs when the load is above 6 (of 8 cores), so new runs are being held.')
    expect(loadTip({ at: 0, load: 5 }, machine).detail).toBe('Paused above 6')
    const meter = footerItems({ runs: [], machine, trouble: null }).find((one) => one.id === 'load')!
    expect(meter).toMatchObject({ text: '6.3 / 6 held' })
  })
})

describe('pressing a chart opens its setting', () => {
  test('Load opens the load limit, Waiting opens runs at once; each says so', () => {
    const opened: string[] = []
    render(<Glance runs={[]} machine={machine} now={120_000} width={400} onOpen={(key) => opened.push(key)} />)
    const load = screen.getByTestId('tile-load-plot').firstElementChild as HTMLElement
    const waiting = screen.getByTestId('tile-queue-plot').firstElementChild as HTMLElement
    expect(load.className).toContain('cursor-pointer')
    expect(load.getAttribute('aria-label')).toContain(CHART_HINTS.load)
    expect(waiting.getAttribute('aria-label')).toContain(CHART_HINTS.queue)
    fireEvent.click(load)
    fireEvent.click(waiting)
    fireEvent.keyDown(load, { key: 'Enter' })
    expect(opened).toEqual([LOAD_KEY, MOST_KEY, LOAD_KEY])
  })

  test('without a way to open, a chart is not pressable', () => {
    render(<Glance runs={[]} machine={machine} now={120_000} width={400} />)
    const load = screen.getByTestId('tile-load-plot').firstElementChild as HTMLElement
    expect(load.className).not.toContain('cursor-pointer')
    expect(load.getAttribute('aria-label')).not.toContain(CHART_HINTS.load)
  })

  const host = (request: Host['request']): Host => ({
    where: 'hosted',
    project: 'p',
    projectPath: '/p',
    projectId: null,
    epic: 'queue',
    parts: [],
    theme: 'light',
    header: () => {},
    activity: () => {},
    request,
    picked: [],
  })
  const api: Api = { ...streams().api, runs: async () => ({ runs: [], machine }), output: async () => ({ text: '', next: 0, size: 0 }), cancel: async () => ({ runs: [], machine }), move: async () => ({ runs: [], machine }), release: async () => ({ runs: [], machine }) }
  const settle = () => act(async () => void (await new Promise((done) => setTimeout(done, 20))))

  test('the page asks the host for settings.open with the key', async () => {
    const asked: Array<[string, unknown]> = []
    render(<Screen host={host(async (method, params) => (asked.push([method, params]), { outcome: 'opened', why: '' }))} api={api} box={{ width: 400, height: 700 }} />)
    await settle()
    fireEvent.click(screen.getByTestId('tile-load-plot').firstElementChild as HTMLElement)
    await settle()
    expect(asked).toEqual([['settings.open', { key: LOAD_KEY }]])
    expect(screen.queryByTestId('jump-said')).toBeNull()
  })

  test('a host that cannot open them: the page says where they are', async () => {
    render(<Screen host={host(async () => Promise.reject(new Error('unknown-method')))} api={api} box={{ width: 400, height: 700 }} />)
    await settle()
    fireEvent.click(screen.getByTestId('tile-queue-plot').firstElementChild as HTMLElement)
    await settle()
    expect(screen.getByTestId('jump-said').textContent).toBe(SETTINGS_WHERE)
  })
})
