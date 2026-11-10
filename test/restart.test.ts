import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addresses, hostAddresses, patienceOf } from '../bin/kehikot-queue.ts'
import { cliToken } from '../queue/machine.ts'

/*
 * Kehikot restarting while a session stays alive: the host and Queue go away and come back on new
 * ports. Stand-ins only — a "Queue" is a small server here, the "registry" a scratch folder, and the
 * "host" a server that proxies `/m/kehikot.queue/…` to it. Never this computer's Kehikot.
 */
const CLI = join(import.meta.dirname, '..', 'bin', 'kehikot-queue')
const made: string[] = []
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const one of cleanup.splice(0)) one()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-restart-'))
  made.push(dir)
  return dir
}

/** A stand-in Queue: answers its health, takes a run, and says it passed (with what ran) when followed. */
function standInQueue(said: string, options: { endFollow?: boolean } = {}) {
  const taken: unknown[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/healthz') return Response.json({ ok: true, id: 'kehikot.queue' })
      if (path === '/api/queue/run') {
        taken.push(await request.json())
        return Response.json({ ok: true, id: 'r1', key: 'k1', run: { state: 'queued', position: 1 } })
      }
      if (path === '/api/queue/follow') {
        if (options.endFollow === false) {
          /* Says it is queued, then the stream breaks: Queue went away mid-wait. */
          return new Response(`${JSON.stringify({ run: { id: 'r1', state: 'queued', waiting: 'first in line' } })}\n`)
        }
        const end = { id: 'r1', state: 'passed', exit: 0, why: null, waiting: null, position: null }
        return new Response(`${JSON.stringify({ out: `${said}\n`, next: 1 })}\n${JSON.stringify({ end })}\n`)
      }
      return new Response('no', { status: 404 })
    },
  })
  cleanup.push(() => server.stop(true))
  return { server, taken, url: `http://127.0.0.1:${server.port}` }
}

/** A port nothing answers on: bound once and let go. */
function deadPort(): number {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = server.port!
  server.stop(true)
  return port
}

function machine() {
  const queueDir = scratch()
  cliToken(queueDir)
  const modules = scratch()
  const register = (url: string) => writeFileSync(join(modules, 'kehikot.queue.json'), JSON.stringify({ url }))
  return { queueDir, modules, register }
}

function spawnCli(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([CLI, ...args], { env: { PATH: process.env.PATH!, HOME: scratch(), KEHIKOT_ORIGINS: 'http://127.0.0.1:9', ...env }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', cwd: tmpdir() })
  return Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(([out, err, code]) => ({ out, err, code }))
}

describe('where Queue is looked for', () => {
  test('its registration as it is now, then the host\'s stable address; only the named address when one is named', () => {
    const { queueDir, modules, register } = machine()
    register('http://127.0.0.1:8110')
    const env = { KEHIKOT_QUEUE_DIR: queueDir, KEHIKOT_MODULES_DIR: modules, KEHIKOT_ORIGINS: 'http://127.0.0.1:4170 tauri://localhost http://localhost:4181' }
    expect(addresses(env).urls).toEqual(['http://127.0.0.1:8110', 'http://127.0.0.1:4170/m/kehikot.queue', 'http://127.0.0.1:4181/m/kehikot.queue'])
    /* Queue moved: the next look reads the registration again. */
    register('http://127.0.0.1:53111/')
    expect(addresses(env).urls[0]).toBe('http://127.0.0.1:53111')
    expect(addresses({ ...env, KEHIKOT_QUEUE_URL: 'http://127.0.0.1:7' }).urls).toEqual(['http://127.0.0.1:7'])
  })
  test('the app\'s own host only for the machine\'s own registry, so a moved registry never reaches this computer\'s Kehikot', () => {
    expect(hostAddresses({})).toEqual(['http://127.0.0.1:4170/m/kehikot.queue'])
    expect(hostAddresses({ KEHIKOT_MODULES_DIR: '/x' })).toEqual([])
  })
  test('patience is 20 s unless said', () => {
    expect(patienceOf({})).toBe(20_000)
    expect(patienceOf({ KEHIKOT_QUEUE_PATIENCE: '0' })).toBe(0)
    expect(patienceOf({ KEHIKOT_QUEUE_PATIENCE: '3' })).toBe(3000)
    expect(patienceOf({ KEHIKOT_QUEUE_PATIENCE: 'soon' })).toBe(20_000)
  })
})

describe('Kehikot restarting while a session runs a command', () => {
  test('a guard\'s rewrite waits for Queue to come back on a new port and is queued there, not run unguarded', async () => {
    const { queueDir, modules, register } = machine()
    /* Before the restart Queue was here; now nothing answers there. */
    register(`http://127.0.0.1:${deadPort()}`)
    const project = scratch()
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }))
    const running = Bun.spawn([CLI, 'run', '--guard', '--', 'sh', '-c', 'bun test'], {
      env: { PATH: process.env.PATH!, HOME: scratch(), KEHIKOT_ORIGINS: 'http://127.0.0.1:9', KEHIKOT_QUEUE_DIR: queueDir, KEHIKOT_MODULES_DIR: modules, KEHIKOT_QUEUE_PATIENCE: '10' },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      cwd: project,
    })
    await Bun.sleep(1500)
    /* Queue is back, on another port, and has registered there. */
    const back = standInQueue('ran in the queue')
    register(back.url)
    const [out, err, code] = await Promise.all([new Response(running.stdout).text(), new Response(running.stderr).text(), running.exited])
    expect(err).toContain('Kehikot may be restarting')
    expect(err).not.toContain('Running it here')
    expect(back.taken).toHaveLength(1)
    expect(out).toBe('ran in the queue\n')
    expect(code).toBe(0)
  })
  test('found through the host\'s stable address while the registration still names the old port', async () => {
    const { queueDir, modules, register } = machine()
    register(`http://127.0.0.1:${deadPort()}`)
    const queue = standInQueue('through the host')
    const host = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (!url.pathname.startsWith('/m/kehikot.queue/')) return new Response('no', { status: 404 })
        const body = request.method === 'GET' ? undefined : await request.arrayBuffer()
        return fetch(`${queue.url}${url.pathname.slice('/m/kehikot.queue'.length)}${url.search}`, { method: request.method, headers: request.headers, body })
      },
    })
    cleanup.push(() => host.stop(true))
    const got = await spawnCli(['run', '--', 'sh', '-c', 'echo never here'], { KEHIKOT_QUEUE_DIR: queueDir, KEHIKOT_MODULES_DIR: modules, KEHIKOT_ORIGINS: `http://127.0.0.1:${host.port}`, KEHIKOT_QUEUE_PATIENCE: '0' })
    expect(queue.taken).toHaveLength(1)
    expect(got.out).toBe('through the host\n')
    expect(got.code).toBe(0)
  })
  test('when Queue never comes back the command runs here after the wait, and says why', async () => {
    const { queueDir, modules, register } = machine()
    register(`http://127.0.0.1:${deadPort()}`)
    const started = Date.now()
    const got = await spawnCli(['run', '--', 'sh', '-c', 'echo here; exit 4'], { KEHIKOT_QUEUE_DIR: queueDir, KEHIKOT_MODULES_DIR: modules, KEHIKOT_QUEUE_PATIENCE: '2' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
    expect(got.err).toContain('nothing answered for 2 s')
    expect(got.err).toContain('outside the queue')
    expect(got.out).toBe('here\n')
    expect(got.code).toBe(4)
  })
  test('a run being followed when Queue goes away is followed to wherever Queue comes back', async () => {
    const { queueDir, modules, register } = machine()
    const before = standInQueue('never', { endFollow: false })
    register(before.url)
    const running = spawnCli(['run', '--', 'sh', '-c', 'echo never here'], { KEHIKOT_QUEUE_DIR: queueDir, KEHIKOT_MODULES_DIR: modules, KEHIKOT_QUEUE_PATIENCE: '0' })
    await Bun.sleep(500)
    before.server.stop(true)
    const after = standInQueue('finished after the restart')
    register(after.url)
    const got = await running
    expect(before.taken).toHaveLength(1)
    expect(after.taken).toHaveLength(0)
    expect(got.out).toBe('finished after the restart\n')
    expect(got.code).toBe(0)
  }, 15_000)
  test('`wait` waits for Queue to come back too', async () => {
    const { queueDir, modules, register } = machine()
    register(`http://127.0.0.1:${deadPort()}`)
    const waiting = spawnCli(['wait', 'r1'], { KEHIKOT_QUEUE_DIR: queueDir, KEHIKOT_MODULES_DIR: modules, KEHIKOT_QUEUE_PATIENCE: '10' })
    await Bun.sleep(1200)
    const back = standInQueue('waited across the restart')
    register(back.url)
    const got = await waiting
    expect(got.out).toBe('waited across the restart\n')
    expect(got.code).toBe(0)
  })
})
