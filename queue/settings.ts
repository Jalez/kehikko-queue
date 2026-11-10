import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { availableParallelism, loadavg } from 'node:os'
import { join } from 'node:path'

import { defaultCapacity, type Capacity } from './schedule.ts'
import { LIMIT_DEFAULTS, LIMITED, type Limited } from './kinds.ts'
import { kindKey, LEASES_DEFAULT } from './fields.ts'

export { SETTINGS } from './fields.ts'

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

/** One checked change. A sentence refuses it. */
export function writeValue(dir: string, key: string, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'That is a number.'
  if (key === 'most' && (!Number.isInteger(value) || value < 0 || value > 64)) return 'Runs at once is a whole number from 0 to 64.'
  if (key === 'load' && (value < 0.1 || value > 16)) return 'Busy above is a load per core from 0.1 to 16.'
  if (key === 'wait' && (value < 0 || value > 24 * 60)) return 'Start anyway after is from 0 to 1440 minutes.'
  if (KIND_KEYS.includes(key) && (!Number.isInteger(value) || value < 0 || value > 64)) return 'A limit for a kind is a whole number from 0 to 64 (0: none of its own).'
  if (key === 'leases' && (!Number.isInteger(value) || value < 0 || value > 32)) return 'Dev servers at once is a whole number from 0 to 32.'
  if (!['most', 'load', 'wait', 'leases', ...KIND_KEYS].includes(key)) return 'There is no such setting.'
  const next = { ...readValues(dir), [key]: value }
  const temporary = `${file(dir)}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file(dir))
  return null
}

/** The capacity the settings make on a machine of `cores` cores. Pure. */
export function capacityOf(values: Record<string, unknown>, cores: number): Capacity {
  const auto = defaultCapacity(cores)
  const number = (key: string) => (typeof values[key] === 'number' && Number.isFinite(values[key]) ? (values[key] as number) : null)
  const most = number('most')
  const load = number('load')
  const wait = number('wait')
  return {
    most: most && most >= 1 ? Math.floor(most) : auto.most,
    loadAbove: load && load > 0 ? Math.round(load * cores * 100) / 100 : auto.loadAbove,
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
export const loadNow = () => loadavg()[0] ?? 0
