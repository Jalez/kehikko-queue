import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { guardDecision, type PlacedGuard } from 'kehikot-module-protocol'
import { beforeInfo } from 'kehikot-module-protocol/serve'

import { refusalFor, waitsIn } from '../bin/waiting.ts'
import { ASK, mcp } from '../doors.ts'
import { cliDoor, TOKEN_HEADER } from '../queue/cli-door.ts'
import { guardSettingsOf, guardsFor } from '../queue/guards.ts'
import { Queue } from '../queue/queue.ts'

/** The command from issue #48, as the session wrote it. */
const ISSUE = 'for i in $(seq 1 90); do l=$(sysctl -n vm.loadavg | awk \'{print $2}\'); awk "BEGIN{exit !($l < 8)}" && break; sleep 30; done; git push origin HEAD'

describe('commands that wait are not queued (issue #48)', () => {
  test('the command from the issue, in words', () => {
    const said = refusalFor(['sh', '-c', ISSUE])!
    expect(said).toContain('Not queued')
    expect(said).toContain('queue already waits for a quiet machine')
  })
  test('sleeps, watch, polling loops, and reads of the load', () => {
    for (const line of [
      'sleep 30 && git push',
      'git pull; sleep 1',
      'timeout 60 sleep 5',
      'env FOO=1 sleep 2',
      'watch -n 5 uptime',
      'until curl -sf localhost:3000; do :; done',
      'while true; do git fetch; done',
      'while [ -f /tmp/lock ]; do :; done',
      'uptime',
      'uptime | awk \'{print $10}\'',
      'sysctl -n vm.loadavg',
      'sysctl vm.loadavg',
      'cat /proc/loadavg',
      'l=`uptime`; echo $l',
      'echo $(sysctl -n vm.loadavg)',
      'sh -c "sleep 5"',
      'bash -c \'bash -c "sleep 5"\'',
      'bun test --watch',
      'vitest --watch',
      'tsc --watch',
    ]) expect([line, waitsIn(line) !== null]).toEqual([line, true])
  })
  test('the load reading says the queue decides when heavy work starts', () => {
    const said = refusalFor(['sh', '-c', 'sysctl -n vm.loadavg'])!
    expect(said).toContain('reads the machine\'s load')
    expect(said).toContain('queue already waits for a quiet machine')
  })
  test('what is legitimate still is: a test runner whose name contains "watch", flags that are not a program, loops over input', () => {
    for (const line of [
      'bun test',
      'bun test src/watch.test.ts',
      'bun test watcher.test.ts',
      'npx vitest run',
      'vitest run --reporter=dot',
      'bun run watch-files-check',
      'bun run typecheck',
      'tsc --noEmit',
      'node scripts/sleep-detector.js',
      'git push origin HEAD',
      'echo "sleep is for the weak"',
      'grep -r sleep src',
      'cat uptime.txt',
      'cat package.json | jq .name',
      'git log --oneline | while read sha msg; do echo $sha; done',
      'while IFS= read -r line; do echo "$line"; done < file',
      'for f in *.ts; do echo $f; done',
      'bun run build && bun test',
      'make -j4 test',
    ]) expect([line, waitsIn(line)]).toEqual([line, null])
  })
  test('an argv that is one program is judged as that program', () => {
    expect(refusalFor(['sleep', '5'])).toContain('it sleeps')
    expect(refusalFor(['bun', 'test', 'watch.test.ts'])).toBeNull()
    expect(refusalFor([])).toBeNull()
  })
})

describe('the same refusal on every way in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-waiting-'))
  let q: Queue
  beforeEach(() => {
    q = new Queue({ dir, capacity: () => ({ most: 2, loadAbove: 100, waitMs: 600_000 }), load: () => 0, sampler: null })
  })
  afterEach(() => {
    q.stop()
    ASK.options = {}
  })

  test('the hook guard denies it, for every agent module that enforces the manifest\'s guards', () => {
    const placed: PlacedGuard[] = guardsFor('/x/kehikot-queue', guardSettingsOf({})).map((guard) => ({ module: 'kehikot.queue', name: 'Queue', guard }))
    for (const command of [ISSUE, 'sleep 30', 'watch -n1 uptime', 'sysctl -n vm.loadavg', 'until true; do :; done', 'uptime']) {
      const said = guardDecision(placed, command, { env: {} })
      expect([command, said.action]).toEqual([command, 'deny'])
    }
    for (const command of ['bun test', 'git push', 'bun test watch.test.ts', 'vitest --watch', 'cat uptime.txt', 'echo sleeping']) {
      expect([command, guardDecision(placed, command, { env: {} }).action === 'deny']).toEqual([command, false])
    }
    /* The escape the protocol has for every guard still works. */
    expect(guardDecision(placed, 'KEHIKOT_DIRECT=1 sleep 3', { env: {} }).action).toBe('pass')
  })
  test('the CLI door refuses it, so an old CLI cannot queue it', async () => {
    const TOKEN = 'A'.repeat(43)
    const request = new Request('http://127.0.0.1:8110/api/queue/run', { method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: TOKEN }, body: JSON.stringify({ argv: ['sh', '-c', ISSUE], cwd: tmpdir(), env: { PATH: process.env.PATH }, kind: 'push' }) })
    const answer = await cliDoor({ queue: () => q, token: () => TOKEN, everyMs: 50 })(request, beforeInfo(request))
    expect(answer?.status).toBe(422)
    const body = (await answer!.json()) as { refused: boolean; error: string }
    expect(body.refused).toBe(true)
    expect(body.error).toContain('waits')
    expect(q.list()).toHaveLength(0)
  })
  test('queue_run refuses it', async () => {
    const reply = await mcp({ id: 1, method: 'tools/call', params: { name: 'queue_run', arguments: { command: ISSUE, cwd: tmpdir() } } }, new URLSearchParams(), q)
    const result = (reply.body as { result: { content: { text: string }[]; isError?: boolean } }).result
    const text = result.content[0]!.text
    expect(result.isError).toBe(true)
    expect(text).toContain('Not queued')
    expect(text).toContain('queue already waits for a quiet machine')
  })
  test('the CLI refuses it before it asks the queue, with or without the guard', async () => {
    const run = async (args: string[]) => {
      const child = Bun.spawn([join(import.meta.dir, '..', 'bin', 'kehikot-queue'), ...args], { env: { PATH: process.env.PATH!, HOME: dir, KEHIKOT_ORIGINS: 'http://127.0.0.1:9', KEHIKOT_QUEUE_PATIENCE: '0' }, stdout: 'pipe', stderr: 'pipe', cwd: tmpdir() })
      const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
      return { err, code }
    }
    const plain = await run(['run', '--', 'sh', '-c', 'sleep 30; git push'])
    expect(plain.code).toBe(1)
    expect(plain.err).toContain('queue already waits for a quiet machine')
    const guarded = await run(['run', '--guard', '--', 'sh', '-c', ISSUE])
    expect(guarded.code).toBe(1)
    expect(guarded.err).toContain('Not queued')
    /* The protocol's escape still passes a guarded line (it is not queued: it runs at once). */
    const escaped = await run(['run', '--guard', '--', 'sh', '-c', 'KEHIKOT_DIRECT=1 sleep 0'])
    expect(escaped.code).toBe(0)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
})
