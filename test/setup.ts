import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GlobalRegistrator } from '@happy-dom/global-registrator'

/*
 * Nothing a test does reaches this computer's real Kehikot: the queue's folder and the module
 * registry are scratch folders, and the host is asked at an address nothing answers on (port 9).
 * Set before any module is imported, because `doors.ts` reads the queue's folder once.
 */
const SCRATCH = mkdtempSync(join(tmpdir(), 'kehikot-queue-tests-'))
process.env.KEHIKOT_QUEUE_DIR = join(SCRATCH, 'queue')
process.env.KEHIKOT_MODULES_DIR = join(SCRATCH, 'modules')
process.env.KEHIKOT_ORIGINS = 'http://127.0.0.1:9'
process.env.KEHIKOT_ORIGIN = 'http://127.0.0.1:9'
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }))

/* A document for the tests that render one; the pure tests do not care. Bun's own fetch, Request,
   Response and Headers are kept: a browser's refuse to carry `Origin`, which the door tests send. */
const own = { fetch: globalThis.fetch, Request: globalThis.Request, Response: globalThis.Response, Headers: globalThis.Headers }
GlobalRegistrator.register()
Object.assign(globalThis, own)
