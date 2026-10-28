import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { agentEnv } from '../doors.ts'
import { shellSpawner } from '../queue/runner.ts'

describe('an agent’s run', () => {
  test('runs the person’s bun, not the one the host put first on this module’s PATH', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'queue-person-env-'))
    try {
      /* The host's shim and Bun's own node shim, each a `bun` that is this module's runtime. */
      const hostShim = join(scratch, 'kehikot-bun-1')
      const bunNode = join(scratch, 'bun-node-502-x')
      for (const dir of [hostShim, bunNode]) {
        mkdirSync(dir)
        symlinkSync(process.execPath, join(dir, 'bun'))
      }
      symlinkSync(process.execPath, join(bunNode, 'node'))
      const person = join(scratch, 'person')
      mkdirSync(person)
      writeFileSync(join(person, 'bun'), '#!/bin/sh\necho person-bun\n')
      chmodSync(join(person, 'bun'), 0o755)
      const env = agentEnv({
        PATH: [bunNode, hostShim, person, '/usr/bin', '/bin'].join(delimiter),
        KEHIKOT_HOST_PATH: hostShim,
        BUN_BE_BUN: '1',
        HOME: '/home/me',
      })
      expect(env).toEqual({ PATH: [person, '/usr/bin', '/bin'].join(delimiter), HOME: '/home/me' })
      const log = join(scratch, 'log')
      const started = shellSpawner.start({ argv: ['/bin/sh', '-c', 'command -v bun; bun --version'], cwd: scratch, env, log, exit: join(scratch, 'exit') })
      expect(await started.exited).toBe(0)
      expect(readFileSync(log, 'utf8')).toBe(`${join(person, 'bun')}\nperson-bun\n`)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
