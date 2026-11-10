import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { guardDecision, manifestSchema, type PlacedGuard } from 'kehikot-module-protocol'
import { beforeInfo } from 'kehikot-module-protocol/serve'

import { escaped, planOf, simpleCommands } from '../bin/guard-plan.ts'
import { guardSettingsOf, guardsFor } from '../queue/guards.ts'
import { MANIFEST } from '../doors.ts'
import { cliDoor } from '../queue/cli-door.ts'
import { cliToken } from '../queue/machine.ts'
import { Queue } from '../queue/queue.ts'
import { writeValue, readValues } from '../queue/settings.ts'

const CLI = '/Users/x/Library/Application Support/Kehikot/installed/kehikot.queue/bin/kehikot-queue'
const made: string[] = []
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const one of cleanup.splice(0)) one()
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-guards-'))
  made.push(dir)
  return dir
}
const placed = (guards = guardsFor(CLI, guardSettingsOf({}))): PlacedGuard[] => guards.map((guard) => ({ module: 'kehikot.queue', name: 'Queue', guard }))
const decide = (command: string, env: Record<string, string> = {}) => guardDecision(placed(), command, { env })

describe('Queue\'s guards, as the agent modules enforce them', () => {
  test('two rewrites that the protocol takes: heavy work to the queue, dev servers to a lease', () => {
    const guards = guardsFor(CLI, guardSettingsOf({}))
    expect(guards.map((one) => [one.id, one.action])).toEqual([['heavy', 'rewrite'], ['dev', 'rewrite']])
    expect(guards[0]!.rewrite).toBe(`'${CLI}' run --guard -- sh -c {command}`)
    expect(guards[1]!.rewrite).toBe(`'${CLI}' lease dev --guard -- sh -c {command}`)
    expect(manifestSchema.parse({ ...MANIFEST, guards }).guards).toHaveLength(2)
  })
  test('the served manifest declares them', () => {
    expect(MANIFEST.guards?.map((one) => one.id)).toEqual(['heavy', 'dev'])
  })
  test('a typecheck, tests, browser tests, a build, an install and their scripts are rewritten to the wrapper', () => {
    for (const command of ['tsc --noEmit', 'npx vitest run', 'bun test', 'npx playwright test', 'vite build', 'bun install', 'npm ci', 'bun run test', 'bun run typecheck', 'npm test', 'cd app && bun run build']) {
      const said = decide(command)
      expect([command, said.action]).toEqual([command, 'rewrite'])
      if (said.action === 'rewrite') expect(said.command.startsWith(`'${CLI}' run --guard -- sh -c `)).toBe(true)
    }
  })
  test('the whole command goes in, as one word', () => {
    const said = decide("cd app && bun run typecheck")
    expect(said.action === 'rewrite' && said.command).toBe(`'${CLI}' run --guard -- sh -c 'cd app && bun run typecheck'`)
  })
  test('dev servers go to a lease; a build of the same tool goes to the queue', () => {
    for (const command of ['bun run dev', 'vite', 'npx vite --port 5280', 'next dev']) {
      const said = decide(command)
      expect(said.action === 'rewrite' && said.command.includes(' lease dev --guard ')).toBe(true)
    }
    const build = decide('vite build')
    expect(build.action === 'rewrite' && build.command.includes(' run --guard ')).toBe(true)
  })
  test('KEHIKOT_DIRECT=1 escapes; asking a tool its version, and anything else, passes', () => {
    expect(decide('KEHIKOT_DIRECT=1 tsc --noEmit').action).toBe('pass')
    expect(decide('tsc --noEmit', { KEHIKOT_DIRECT: '1' }).action).toBe('pass')
    for (const command of ['tsc --version', 'vite --version', 'ls -la', 'grep -n tsc package.json', 'git status', 'bun run lint']) expect([command, decide(command).action]).toEqual([command, 'pass'])
  })
  test('the person widens and narrows it in settings, or turns it off', () => {
    const dir = scratch()
    expect(writeValue(dir, 'guard_commands', ['cargo test', 'not; valid'])).toBeNull()
    expect(writeValue(dir, 'guard_scripts', ['check'])).toBeNull()
    expect(writeValue(dir, 'guard_direct', ['tsc -p small'])).toBeNull()
    const guards = guardsFor(CLI, guardSettingsOf(readValues(dir)))
    expect(guards[0]!.match.commands).toContain('cargo test')
    expect(guards[0]!.match.commands).not.toContain('not; valid')
    const decided = (command: string) => guardDecision(placed(guards), command).action
    expect(decided('cargo test --all')).toBe('rewrite')
    expect(decided('bun run check')).toBe('rewrite')
    expect(decided('tsc -p small')).toBe('pass')
    expect(writeValue(dir, 'guards', false)).toBeNull()
    expect(guardsFor(CLI, guardSettingsOf(readValues(dir)))).toEqual([])
    expect(writeValue(dir, 'guards', 'yes')).toContain('on or off')
    expect(writeValue(dir, 'guard_scripts', 'check')).toContain('list')
  })
})

describe('what the wrapper does with a rewritten command, in this project', () => {
  const scripts = (map: Record<string, Record<string, string>>) => (dir: string) => map[dir] ?? null
  test('one test file runs at once; a suite is queued as tests', () => {
    expect(planOf('bun test src/a.test.ts', '/p', scripts({}))).toEqual({ direct: expect.any(String) })
    expect(planOf('npx vitest run src/a.test.ts', '/p', scripts({}))).toEqual({ direct: expect.any(String) })
    expect(planOf('jest test/a.spec.js', '/p', scripts({}))).toEqual({ direct: expect.any(String) })
    expect(planOf('bun test', '/p', scripts({}))).toEqual({ queue: 'verify' })
    expect(planOf('vitest run src/a.test.ts src/b.test.ts', '/p', scripts({}))).toEqual({ queue: 'verify' })
    expect(planOf('bun test src/', '/p', scripts({}))).toEqual({ queue: 'verify' })
  })
  test('each kind its own: typecheck, e2e, build, install', () => {
    expect(planOf('tsc --noEmit', '/p', scripts({}))).toEqual({ queue: 'typecheck' })
    expect(planOf('npx playwright test e2e/one.spec.ts', '/p', scripts({}))).toEqual({ queue: 'e2e' })
    expect(planOf('vite build', '/p', scripts({}))).toEqual({ queue: 'build' })
    expect(planOf('bun install --frozen-lockfile', '/p', scripts({}))).toEqual({ queue: 'task' })
    expect(planOf('bun install && tsc --noEmit && bun test', '/p', scripts({}))).toEqual({ queue: 'typecheck' })
    expect(planOf('tsc --version', '/p', scripts({}))).toEqual({ direct: expect.any(String) })
  })
  test('a script is what its own line in package.json is; one it does not have, by its name', () => {
    const at = scripts({ '/p': { test: 'vitest run', build: 'echo nothing to build', typecheck: 'tsc --noEmit', check: 'bun run typecheck && bun test', e2e: 'playwright test' }, '/p/sub': { test: 'jest' } })
    expect(planOf('bun run test', '/p', at)).toEqual({ queue: 'verify' })
    expect(planOf('bun run build', '/p', at)).toEqual({ direct: expect.any(String) })
    expect(planOf('npm run check', '/p', at)).toEqual({ queue: 'typecheck' })
    expect(planOf('pnpm e2e', '/p', at)).toEqual({ queue: 'e2e' })
    expect(planOf('cd sub && npm test', '/p', at)).toEqual({ queue: 'verify' })
    expect(planOf('bun run test:e2e', '/p', at)).toEqual({ queue: 'e2e' })
    expect(planOf('bun run lint', '/p', at)).toEqual({ direct: expect.any(String) })
  })
  test('lines are split as a shell would, quotes kept', () => {
    expect(simpleCommands("cd 'a b' && FOO=1 bun test | tee x; echo \"c;d\"")).toEqual([['cd', 'a b'], ['FOO=1', 'bun', 'test'], ['tee', 'x'], ['echo', 'c;d']])
    expect(escaped('KEHIKOT_DIRECT=1 bun test', {})).toBe(true)
    expect(escaped('KEHIKOT_DIRECT=0 bun test', {})).toBe(false)
    expect(escaped('bun test', { KEHIKOT_DIRECT: '1' })).toBe(true)
  })
})

describe('the CLI, as a guard runs it', () => {
  const BIN = join(import.meta.dirname, '..', 'bin', 'kehikot-queue')
  function serve() {
    const queueDir = scratch()
    const token = cliToken(queueDir)
    const q = new Queue({ dir: join(queueDir, 'state'), capacity: () => ({ most: 0, loadAbove: 100, waitMs: 600_000 }), load: () => 0, tickMs: 50 })
    const door = cliDoor({ queue: () => q, token: () => token, everyMs: 30 })
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (new URL(request.url).pathname === '/healthz') return Response.json({ ok: true, id: 'kehikot.queue' })
      return (await door(request, beforeInfo(request))) ?? new Response('no', { status: 404 })
    } })
    cleanup.push(() => {
      q.stop()
      server.stop(true)
    })
    return { q, env: { PATH: process.env.PATH!, HOME: scratch(), KEHIKOT_QUEUE_URL: `http://127.0.0.1:${server.port}`, KEHIKOT_QUEUE_DIR: queueDir, KEHIKOT_MODULES_DIR: scratch() } }
  }
  test('light work runs at once and says nothing; nothing is queued', async () => {
    const { q, env } = serve()
    const child = Bun.spawn([BIN, 'run', '--guard', '--', 'sh', '-c', 'echo light; exit 3'], { env, stdout: 'pipe', stderr: 'pipe', cwd: scratch() })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect([out, err, code]).toEqual(['light\n', '', 3])
    expect(q.list()).toEqual([])
  })
  test('a heavy script is queued as its kind, from the project\'s package.json', async () => {
    const { q, env } = serve()
    const project = scratch()
    mkdirSync(join(project, 'web'))
    writeFileSync(join(project, 'web', 'package.json'), JSON.stringify({ scripts: { check: 'tsc --noEmit' } }))
    const child = Bun.spawn([BIN, 'run', '--guard', '--', 'sh', '-c', 'cd web && bun run check'], { env: { ...env, CLAUDECODE: '1' }, stdout: 'pipe', stderr: 'pipe', cwd: project })
    for (let i = 0; i < 100 && !q.list().length; i++) await new Promise((done) => setTimeout(done, 30))
    expect(q.list()[0]).toMatchObject({ kind: 'typecheck', state: 'queued', asker: expect.objectContaining({ said: expect.stringContaining('through Queue\'s guard') }) })
    child.kill('SIGTERM')
    expect(await child.exited).toBe(130)
  })
  test('KEHIKOT_DIRECT=1 runs it at once', async () => {
    const { q, env } = serve()
    const child = Bun.spawn([BIN, 'run', '--guard', '--', 'sh', '-c', 'KEHIKOT_DIRECT=1 echo tsc'], { env, stdout: 'pipe', stderr: 'pipe', cwd: scratch() })
    expect(await new Response(child.stdout).text()).toBe('tsc\n')
    expect(await child.exited).toBe(0)
    expect(q.list()).toEqual([])
  })
})
