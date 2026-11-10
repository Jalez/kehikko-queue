import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeInfo } from 'kehikot-module-protocol/serve'

import { agentOf, autoLabel, parse, parseLease, sessionOf, sessionPidOf } from '../bin/kehikot-queue.ts'
import { cliDoor } from '../queue/cli-door.ts'
import { cliToken } from '../queue/machine.ts'
import { Queue } from '../queue/queue.ts'
import { Leases } from '../queue/leases.ts'
import { alive } from '../queue/runner.ts'

/*
 * `kehikot-queue run` as a transparent stand-in for a heavy command (what a shell guard rewrites
 * it to), and `kehikot-queue lease dev`: a separate process each, against a queue served here.
 */
const CLI = join(import.meta.dirname, '..', 'bin', 'kehikot-queue')
const made: string[] = []
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const one of cleanup.splice(0)) one()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-wrap-'))
  made.push(dir)
  return dir
}
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms))

function serve(most = 1) {
  const queueDir = scratch()
  const token = cliToken(queueDir)
  const q = new Queue({ dir: join(queueDir, 'state'), capacity: () => ({ most, loadAbove: 100, waitMs: 600_000 }), load: () => 0, tickMs: 50 })
  const leases = new Leases({ dir: join(queueDir, 'state'), most: () => 2 })
  const timer = setInterval(() => leases.tick(), 50)
  const door = cliDoor({ queue: () => q, leases: () => leases, token: () => token, everyMs: 30 })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/healthz') return Response.json({ ok: true, id: 'kehikot.queue' })
      return (await door(request, beforeInfo(request))) ?? new Response('no', { status: 404 })
    },
  })
  cleanup.push(() => {
    clearInterval(timer)
    leases.stopAll('test done')
    q.stop()
    server.stop(true)
  })
  const env = { PATH: process.env.PATH!, HOME: scratch(), KEHIKOT_QUEUE_URL: `http://127.0.0.1:${server.port}`, KEHIKOT_QUEUE_DIR: queueDir, KEHIKOT_MODULES_DIR: scratch() }
  return { q, leases, env }
}

const spawnCli = (args: string[], env: Record<string, string>) => Bun.spawn([CLI, ...args], { env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', cwd: tmpdir() })
async function cli(args: string[], env: Record<string, string>) {
  const child = spawnCli(args, env)
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { out, err, code }
}

describe('the wrapper\'s own pieces', () => {
  test('a run is labelled from its folder and its command\'s own words', () => {
    expect(autoLabel(['bun', 'run', 'typecheck'], '/w/kehikko-queue')).toBe('kehikko-queue: bun run typecheck')
    expect(autoLabel(['/bin/sh', '-c', 'cd pkg && FOO=1 npx vitest run'], '/w/app')).toBe('app: npx vitest run')
    expect(autoLabel(['bash', '-lc', 'env CI=1 tsc --noEmit'], '/w/app')).toBe('app: tsc --noEmit')
    expect(autoLabel(['x', 'y'.repeat(300)], '/w/app').length).toBeLessThanOrEqual(100)
  })
  test('the asking session: --session, else KEHIKOT_SESSION_ID, else the agent CLI\'s own', () => {
    expect(sessionOf({ CLAUDE_CODE_SESSION_ID: 'abc-123' })).toBe('abc-123')
    expect(sessionOf({ KEHIKOT_SESSION_ID: 'mine', CLAUDE_CODE_SESSION_ID: 'abc' })).toBe('mine')
    expect(sessionOf({ CLAUDE_CODE_SESSION_ID: 'bad id; rm' })).toBeNull()
    expect(parse(['--session', 's1', '--agent', 'reviewer', '--', 'x'], {})).toMatchObject({ session: 's1', agent: 'reviewer' })
    expect(parse(['--', 'x'], { CLAUDE_CODE_SESSION_ID: 'from-env', CLAUDECODE: '1' })).toMatchObject({ session: 'from-env', agent: 'Claude Code' })
    expect(agentOf({ KEHIKOT_AGENT: 'subagent: Explore' })).toBe('subagent: Explore')
  })
  test('unit and playwright are kinds a guard may name', () => {
    expect(parse(['--kind', 'unit', '--', 'x'], {})).toMatchObject({ kind: 'verify' })
    expect(parse(['--kind', 'playwright', '--', 'x'], {})).toMatchObject({ kind: 'e2e' })
    expect(parse(['--kind', 'typecheck', '--', 'x'], {})).toMatchObject({ kind: 'typecheck' })
  })
  test('the session\'s process: from the environment, else the nearest agent CLI above', () => {
    expect(sessionPidOf({ CLAUDE_PID: '4242' })).toBe(4242)
    const tree: Record<number, { ppid: number; command: string }> = { [process.ppid]: { ppid: 77, command: 'zsh' }, 77: { ppid: 1, command: 'claude' } }
    expect(sessionPidOf({}, (pid) => tree[pid] ?? null)).toBe(77)
    expect(sessionPidOf({}, () => ({ ppid: 1, command: 'zsh' }))).toBeNull()
  })
  test('lease dev parses its range and time', () => {
    expect(parseLease(['dev', '--port-range', '5280-5299', '--ttl', '30', '--', 'bun', 'run', 'dev'], {})).toMatchObject({ range: '5280-5299', ttl: 30, argv: ['bun', 'run', 'dev'] })
    expect(parseLease(['web', '--', 'x'], {})).toContain('lease dev')
    expect(parseLease(['dev', '--port-range', 'lots', '--', 'x'], {})).toContain('FROM-TO')
  })
})

describe('kehikot-queue run as a stand-in for the command', () => {
  test('streams the output on stdout, says its own lines on stderr only, exits with the command\'s code, and records the session', async () => {
    const { q, env } = serve()
    const got = await cli(['run', '--kind', 'typecheck', '--', 'sh', '-c', 'echo checked; exit 4'], { ...env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-0001' })
    expect(got.code).toBe(4)
    expect(got.out).toBe('checked\n')
    expect(got.err).toContain('failed (exit 4)')
    const run = q.list()[0]!
    expect(run.kind).toBe('typecheck')
    expect(run.label).toBe(autoLabel(['sh', '-c', 'echo checked; exit 4'], tmpdir()))
    expect(run.asker).toMatchObject({ session: 'sess-0001', agent: 'Claude Code' })
    expect(typeof run.asker.holder).toBe('number')
  })
  test('inside a queued run it runs at once, so a run never waits behind itself', async () => {
    const { q, env } = serve()
    const got = await cli(['run', '--', 'sh', '-c', 'echo inner'], { ...env, KEHIKOT_QUEUE_RUN: 'r-outer' })
    expect(got.code).toBe(0)
    expect(got.out).toBe('inner\n')
    expect(got.err).toContain('already inside queued run r-outer')
    expect(q.list()).toEqual([])
  })
  test('the run itself is told it is inside the queue', async () => {
    const { env } = serve()
    const got = await cli(['run', '--', 'sh', '-c', 'echo "[$KEHIKOT_QUEUE_RUN]"'], env)
    expect(got.out).toMatch(/^\[r\w+\]\n$/)
  })
  test('ended without a terminal (SIGTERM, as a tool\'s timeout does) while waiting: the queued run is cancelled', async () => {
    const { q, env } = serve(0)
    const child = spawnCli(['run', '--', 'sh', '-c', 'echo never'], env)
    for (let i = 0; i < 100 && !q.list().length; i++) await settle(30)
    expect(q.list()[0]!.state).toBe('queued')
    child.kill('SIGTERM')
    expect(await child.exited).toBe(130)
    expect(q.list()[0]!.state).toBe('cancelled')
  })
  test('killed without a word (SIGKILL) while waiting: the queue notices its asker has gone and cancels it', async () => {
    const { q, env } = serve(0)
    const child = spawnCli(['run', '--', 'sh', '-c', 'echo never'], env)
    for (let i = 0; i < 100 && !q.list().length; i++) await settle(30)
    child.kill('SIGKILL')
    await child.exited
    for (let i = 0; i < 100 && q.list()[0]!.state === 'queued'; i++) await settle(30)
    expect(q.list()[0]!).toMatchObject({ state: 'cancelled', why: expect.stringContaining('stopped waiting') })
  })
})

describe('kehikot-queue lease dev', () => {
  test('runs the server on a free port of the range, streams its output, and stops its whole group when the command ends', async () => {
    const { leases, env } = serve()
    const child = spawnCli(['lease', 'dev', '--port-range', '5390-5399', '--', 'sh', '-c', 'echo "serving on $PORT {port}"; sleep 30 & wait'], env)
    const reader = child.stdout.getReader()
    let out = ''
    for (let i = 0; i < 100 && !out.includes('serving'); i++) {
      const { value } = await Promise.race([reader.read(), settle(100).then(() => ({ value: undefined }))])
      if (value) out += new TextDecoder().decode(value)
    }
    const lease = leases.running()[0]!
    expect(out).toContain(`serving on ${lease.port} ${lease.port}`)
    expect(lease.port).toBeGreaterThanOrEqual(5390)
    expect(lease.port).toBeLessThanOrEqual(5399)
    expect(alive(lease.pid!)).toBe(true)
    child.kill('SIGTERM')
    expect(await child.exited).toBe(143)
    expect(leases.get(lease.id)!.state).toBe('ended')
    for (let i = 0; i < 100 && alive(lease.pid!); i++) await settle(30)
    expect(alive(lease.pid!)).toBe(false)
  })
  test('killed without a word: the lease ends when its holder has gone', async () => {
    const { leases, env } = serve()
    const child = spawnCli(['lease', 'dev', '--port-range', '5380-5389', '--', 'sh', '-c', 'sleep 30 & wait'], env)
    for (let i = 0; i < 100 && !leases.running().length; i++) await settle(30)
    const lease = leases.running()[0]!
    child.kill('SIGKILL')
    await child.exited
    for (let i = 0; i < 100 && leases.get(lease.id)!.state === 'running'; i++) await settle(30)
    expect(leases.get(lease.id)!).toMatchObject({ state: 'ended', why: 'The command that leased it ended.' })
  })
})
