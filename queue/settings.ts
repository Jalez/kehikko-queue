import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { availableParallelism, loadavg } from 'node:os'
import { join } from 'node:path'

import { defaultCapacity, type Capacity } from './schedule.ts'
import { LIMIT_DEFAULTS, LIMITED, type Limited } from './kinds.ts'
import { autoLoad, kindKey, LEASES_DEFAULT, LOAD_KEY, settingsFor } from './fields.ts'

const KIND_KEYS = LIMITED.map(kindKey)

export type Values = { most: number; load: number; wait: number }

const file = (dir: string) => join(dir, 'settings.json')

export function readValues(dir: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file(dir), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const LISTS = ['guard_commands', 'guard_scripts', 'guard_direct']

/** One checked change. A sentence refuses it. */
export function writeValue(dir: string, key: string, value: unknown): string | null {
  if (key === 'guards') return typeof value === 'boolean' ? save(dir, key, value) : 'That is on or off.'
  if (LISTS.includes(key)) {
    if (!Array.isArray(value) || value.length > 32 || value.some((one) => typeof one !== 'string' || one.length > 120)) return 'That is a list of at most 32 lines, each at most 120 characters.'
    return save(dir, key, value.map((one: string) => one.trim()).filter(Boolean))
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'That is a number.'
  if (key === 'most' && (!Number.isInteger(value) || value < 0 || value > 64)) return 'Runs at once is a whole number from 0 to 64.'
  if (key === LOAD_KEY && (value < 0 || value > 1024)) return 'Pause new runs above load is a load from 0 to 1024 (0: Queue decides).'
  if (key === 'wait' && (value < 0 || value > 24 * 60)) return 'Start anyway after is from 0 to 1440 minutes.'
  if (KIND_KEYS.includes(key) && (!Number.isInteger(value) || value < 0 || value > 64)) return 'A limit for a kind is a whole number from 0 to 64 (0: none of its own).'
  if (key === 'leases' && (!Number.isInteger(value) || value < 0 || value > 32)) return 'Dev servers at once is a whole number from 0 to 32.'
  if (!['most', LOAD_KEY, 'wait', 'leases', ...KIND_KEYS].includes(key)) return 'There is no such setting.'
  return save(dir, key, value)
}

function save(dir: string, key: string, value: unknown): null {
  writeValues(dir, { ...readValues(dir), [key]: value })
  return null
}

function writeValues(dir: string, next: Record<string, unknown>): void {
  const temporary = `${file(dir)}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file(dir))
  cached = null
}

/**
 * Before 0.20.3, the load limit was kept per core (`load`, 0.75), while the chart, the footer and the
 * queue's reasons all said the load itself (9 on 12 cores): two numbers for one limit. It is now the
 * load itself (`load_above`). A kept `load` becomes `load_above` on this computer's cores, once, and
 * goes. Pure but for the file; answers whether it moved anything.
 */
export function migrateValues(dir: string, cores: number): boolean {
  const values = readValues(dir)
  if (!('load' in values)) return false
  const { load, ...rest } = values
  if (typeof rest[LOAD_KEY] !== 'number' && typeof load === 'number' && Number.isFinite(load) && load > 0) rest[LOAD_KEY] = Math.round(load * cores * 10) / 10
  writeValues(dir, rest)
  return true
}

/* The values as last read, by the folder: the settings door, the page's overview and every tick read
   them, and only a change here moves them. A change made by hand in the file is read at the next start. */
let cached: { dir: string; values: Record<string, unknown> } | null = null

/** The values, from memory after the first read: answering never waits on the disk. */
export function valuesOf(dir: string): Record<string, unknown> {
  if (cached?.dir !== dir) cached = { dir, values: readValues(dir) }
  return cached.values
}

/** The capacity the settings make on a machine of `cores` cores. Pure. */
export function capacityOf(values: Record<string, unknown>, cores: number): Capacity {
  const auto = defaultCapacity(cores)
  const number = (key: string) => (typeof values[key] === 'number' && Number.isFinite(values[key]) ? (values[key] as number) : null)
  const most = number('most')
  const above = number(LOAD_KEY)
  const legacy = number('load')
  const wait = number('wait')
  return {
    most: most && most >= 1 ? Math.floor(most) : auto.most,
    loadAbove: above && above > 0 ? above : legacy && legacy > 0 ? Math.round(legacy * cores * 100) / 100 : autoLoad(cores),
    waitMs: wait !== null && wait >= 0 ? wait * 60_000 : auto.waitMs,
    perKind: perKindOf(values),
  }
}

/** The per-kind limits the settings make: each kind's own, or its default; 0 is none of its own. Pure. */
export function perKindOf(values: Record<string, unknown>): Record<Limited, number> {
  const out = { ...LIMIT_DEFAULTS }
  for (const kind of LIMITED) {
    const said = values[kindKey(kind)]
    if (typeof said === 'number' && Number.isInteger(said) && said >= 0) out[kind] = said
  }
  return out
}

/** How many dev servers may be leased at once. Pure. */
export function leasesOf(values: Record<string, unknown>): number {
  const said = values.leases
  return typeof said === 'number' && Number.isInteger(said) && said >= 0 ? said : LEASES_DEFAULT
}

export const cores = () => availableParallelism()
/** This computer's settings: read the cores here, on the server, never in a file the page imports. */
export const SETTINGS = settingsFor(cores())
export const loadNow = () => loadavg()[0] ?? 0
