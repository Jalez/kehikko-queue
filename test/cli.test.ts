import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeInfo, registryDir } from 'kehikot-module-protocol/serve'

import { exitFor, machineDir, parse, queueDir, where } from '../bin/kehikot-queue.ts'
import { cliDoor } from '../queue/cli-door.ts'
import { cliToken, queueDir as serverQueueDir } from '../queue/machine.ts'
import { Queue } from '../queue/queue.ts'

/*
 * The CLI as a hook runs it: a separate process, its exit code what the hook returns. Never against
 * this computer's Test runs: every location is a scratch folder, and the "module" is a server here.
 */
const CLI = join(import.meta.dirname, '..', 'bin', 'kehikot-queue')
const made: string[] = []
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const one of cleanup.splice(0)) one()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-cli-'))
  made.push(dir)
  return dir
}

async function cli(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([CLI, ...args], { env: { PATH: process.env.PATH!, HOME: scratch(), ...env }, stdout: 'pipe', stderr: 'pipe', cwd: tmpdir() })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { out, err, code }
}

describe('when Test runs is not there, the command runs here and the hook does not break', () => {
  test('not registered: runs directly, says so, and exits with the command\'s code', async () => {
    const got = await cli(['run', '--kind', 'push', '--', 'sh', '-c', 'echo direct; exit 3'], { KEHIKOT_MODULES_DIR: scratch(), KEHIKOT_QUEUE_DIR: scratch() })
    expect(got.code).toBe(3)
    expect(got.out).toBe('direct\n')
    expect(got.err).toContain('not registered')
    expect(got.err).toContain('outside the queue')
  })
  test('registered but not running: runs directly', async () => {
    const queueDir = scratch()
    cliToken(queueDir)
    const modules = scratch()
    writeFileSync(join(modules, 'kehikot.queue.json'), JSON.stringify({ url: 'http://127.0.0.1:9' }))
    const got = await cli(['run', '--', 'sh', '-c', 'exit 0'], { KEHIKOT_MODULES_DIR: modules, KEHIKOT_QUEUE_DIR: queueDir })
    expect(got.code).toBe(0)
    expect(got.err).toContain('not running')
  })
  test('a usage mistake is said, and nothing runs', async () => {
    const got = await cli(['run', '--kind', 'push'], { KEHIKOT_MODULES_DIR: scratch(), KEHIKOT_QUEUE_DIR: scratch() })
    expect(got.code).toBe(2)
    expect(got.err).toContain('after --')
  })
})

describe('through the queue', () => {
  test('waits, prints the output, and exits with the run\'s own exit code', async () => {
    const queueDir = scratch()
    const token = cliToken(queueDir)
    const q = new Queue({ dir: join(queueDir, 'state'), capacity: () => ({ most: 1, loadAbove: 100, waitMs: 600_000 }), load: () => 0 })
    const door = cliDoor({ queue: () => q, token: () => token, everyMs: 50 })
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === '/healthz') return Response.json({ ok: true, id: 'kehikot.queue' })
        return (await door(request, beforeInfo(request))) ?? new Response('no', { status: 404 })
      },
    })
    cleanup.push(() => {
      q.stop()
      server.stop(true)
    })
    const url = `http://127.0.0.1:${server.port}`
    const env = { KEHIKOT_QUEUE_URL: url, KEHIKOT_QUEUE_DIR: queueDir, KEHIKOT_MODULES_DIR: scratch() }
    const failed = await cli(['run', '--kind', 'push', '--label', 'pre-push', '--from', 'pre-push hook', '--', 'sh', '-c', 'echo one; sleep 1; echo two; exit 3'], env)
    expect(failed.code).toBe(3)
    expect(failed.out).toBe('one\ntwo\n')
    expect(failed.err).toContain('failed (exit 3)')
    const passed = await cli(['run', '--', 'sh', '-c', 'exit 0'], env)
    expect(passed.code).toBe(0)
    expect(q.list().map((run) => [run.label, run.state, run.asker.said.startsWith('pre-push hook') || run.asker.said.startsWith('a shell')])).toEqual([
      ['sh -c exit 0', 'passed', true],
      ['pre-push', 'failed', true],
    ])
  })
})

describe('where the CLI and the queue look for Kehikot\'s folder', () => {
  test('off macOS it is spelled `kehikot`, as the host and the module registry spell it', () => {
    const data = scratch()
    expect(machineDir({ XDG_DATA_HOME: data }, 'linux')).toBe(join(data, 'kehikot'))
    expect(machineDir({}, 'linux')).toBe(join(homedir(), '.local', 'share', 'kehikot'))
    expect(machineDir({}, 'darwin')).toBe(join(homedir(), 'Library', 'Application Support', 'Kehikot'))
  })
  test('the registry it reads is the one the protocol writes registrations into', () => {
    const env = { HOME: homedir(), XDG_DATA_HOME: scratch() }
    expect(join(machineDir(env), 'modules')).toBe(registryDir(env))
  })
  test('on Linux it finds the queue registered in the lowercase folder', () => {
    const data = scratch()
    mkdirSync(join(data, 'kehikot', 'modules'), { recursive: true })
    writeFileSync(join(data, 'kehikot', 'modules', 'kehikot.queue.json'), JSON.stringify({ url: 'http://127.0.0.1:7999' }))
    const token = cliToken(join(data, 'kehikot', 'queue'))
    expect(where({ XDG_DATA_HOME: data }, 'linux')).toEqual({ url: 'http://127.0.0.1:7999', token })
  })
  test('the CLI finds a queue registered where the protocol registers it on this computer', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => (new URL(request.url).pathname === '/healthz' ? Response.json({ ok: true, id: 'kehikot.queue' }) : Response.json({ runs: [] })),
    })
    cleanup.push(() => server.stop(true))
    const env = { HOME: scratch(), XDG_DATA_HOME: scratch() }
    mkdirSync(registryDir(env), { recursive: true })
    writeFileSync(join(registryDir(env), 'kehikot.queue.json'), JSON.stringify({ url: `http://127.0.0.1:${server.port}` }))
    const got = await cli(['status'], env)
    expect(got.err).not.toContain('not running')
    expect(got.out).toContain('Nothing queued')
    expect(got.code).toBe(0)
  })
  /* The two spellings are two folders only where names are case-sensitive (Linux); on macOS they are one. */
  const caseSensitive = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-case-'))
    try {
      mkdirSync(join(dir, 'k'))
      return !existsSync(join(dir, 'K'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })()
  test.if(caseSensitive)('a queue folder an earlier version made under `Kehikot` is still the queue\'s, until a lowercase one exists', () => {
    const data = scratch()
    expect(queueDir({ XDG_DATA_HOME: data }, 'linux')).toBe(join(data, 'kehikot', 'queue'))
    const before = join(data, 'Kehikot', 'queue')
    const token = cliToken(before)
    expect(queueDir({ XDG_DATA_HOME: data }, 'linux')).toBe(before)
    expect(serverQueueDir({ XDG_DATA_HOME: data }, 'linux')).toBe(before)
    expect(where({ XDG_DATA_HOME: data }, 'linux').token).toBe(token)
    mkdirSync(join(data, 'kehikot', 'queue'), { recursive: true })
    expect(queueDir({ XDG_DATA_HOME: data }, 'linux')).toBe(join(data, 'kehikot', 'queue'))
  })
  test('the server keeps its queue where the CLI looks for it', () => {
    const data = scratch()
    expect(serverQueueDir({ XDG_DATA_HOME: data }, 'linux')).toBe(join(data, 'kehikot', 'queue'))
    expect(serverQueueDir({ XDG_DATA_HOME: data }, 'darwin')).toBe(join(homedir(), 'Library', 'Application Support', 'Kehikot', 'queue'))
    expect(serverQueueDir({ KEHIKOT_QUEUE_DIR: data }, 'linux')).toBe(data)
  })
})

describe('the CLI\'s own pieces', () => {
  test('parse', () => {
    expect(parse(['--kind', 'push', '--ref', '!1', '--', 'bun', 'test'], {})).toMatchObject({ kind: 'push', refs: ['!1'], argv: ['bun', 'test'] })
    expect(parse(['--kind', 'nightly', '--', 'x'], {})).toContain('--kind')
    expect(parse(['--', 'x'], { KEHIKOT_PLACE: 'tok' })).toMatchObject({ place: 'tok' })
  })
  test('the exit code of an ended run', () => {
    const run = (state: string, exit: number | null) => ({ id: 'r', state, exit, why: null, waiting: null, position: null })
    expect(exitFor(run('passed', 0))).toBe(0)
    expect(exitFor(run('failed', 3))).toBe(3)
    expect(exitFor(run('failed', null))).toBe(1)
    expect(exitFor(run('cancelled', null))).toBe(130)
  })
})

