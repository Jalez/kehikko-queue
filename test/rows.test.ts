import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { rowsAdvice } from 'kehikot-module-protocol'

import { footerItems, type FooterState } from '../src/footer.ts'
import { headerItems } from '../src/header.ts'
import { aRun } from './inbox.test.ts'

/**
 * `kehikot.rows.json` (protocol 2.70.0) is what `bun run check:rows` reads: the header and footer the
 * page declares, one state per moment worth checking. It is built here from the page's own
 * `headerItems` and `footerItems`, so it cannot drift from them: when this test fails, run it with
 * KEHIKOT_WRITE_ROWS=1 to write the file again.
 */
const FILE = join(import.meta.dir, '..', 'kehikot.rows.json')

const machine = { cores: 12, load: 3.2, most: 2, loadAbove: 9, waitMinutes: 10 }

const STATES: Array<{ name: string; footer: FooterState }> = [
  { name: 'reading the queue', footer: { runs: [], machine: null, trouble: null } },
  { name: 'nothing queued', footer: { runs: [], machine, trouble: null } },
  {
    name: 'busy: running, waiting, results, a leased dev server',
    footer: {
      runs: [
        aRun({ id: 'w1', state: 'queued', startedAt: null, finishedAt: null, exit: null, position: 1 }),
        aRun({ id: 'u1', state: 'running', finishedAt: null, exit: null }),
        aRun({ id: 'f1', state: 'failed' }),
        aRun({ id: 'p1', state: 'passed', exit: 0 }),
      ],
      machine: { ...machine, leasesMost: 3 },
      trouble: null,
      leases: [{ id: 'l1', label: 'app: bun run dev', argv: ['bun', 'run', 'dev'], cwd: '/p', project: null, port: 5281, asker: { via: 'cli', said: 'a shell, in /p', token: null, conversation: null }, sessionPid: null, startedAt: 0, until: 1, pid: 1, state: 'running', endedAt: null, why: null, exit: null }],
    },
  },
  { name: 'held: the load above the limit', footer: { runs: [], machine: { ...machine, load: 10 }, trouble: null } },
  { name: 'the queue did not answer', footer: { runs: [], machine: null, trouble: 'The queue did not answer.' } },
]

const rows = () => STATES.map(({ name, footer }) => ({ name, state: true, header: headerItems(), footer: footerItems(footer) }))

describe('kehikot.rows.json (protocol 2.70.0)', () => {
  test('is the header and footer the page declares', () => {
    const now = `${JSON.stringify(rows(), null, 2)}\n`
    if (process.env.KEHIKOT_WRITE_ROWS === '1') writeFileSync(FILE, now)
    expect(readFileSync(FILE, 'utf8')).toBe(now)
  })

  test('follows the rule for what goes in the header and what in the footer', () => {
    for (const one of rows()) expect(rowsAdvice(one.header, one.footer, { state: true })).toEqual([])
  })
})
