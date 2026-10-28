import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { availableParallelism, loadavg } from 'node:os'
import { join } from 'node:path'

import { defaultCapacity, type Capacity } from './schedule.ts'

export { SETTINGS } from './fields.ts'

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
  if (!['most', 'load', 'wait'].includes(key)) return 'There is no such setting.'
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
  }
}

export const cores = () => availableParallelism()
export const loadNow = () => loadavg()[0] ?? 0
