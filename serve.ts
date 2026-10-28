#!/usr/bin/env bun
import { run } from 'kehikot-module-protocol/run'

import { answer, BUILD, MANIFEST, TICKET, queue, servingAt } from './doors.ts'
import { ID, PREFERRED_PORT } from './manifest.ts'
import { QUEUE_DOOR } from './queue/door.ts'
import { isSkillPath } from './skills.ts'

/**
 * This module over its BUILT page (`bun run build`), on the same doors and the same port. `run.sh`
 * starts this when `dist/` carries a stamp of the commit checked out, and Vite otherwise. A stop
 * leaves running runs running: each is its own process group, picked up again at the next start.
 */
const running = await run({
  id: ID,
  prefer: PREFERRED_PORT,
  dir: import.meta.dirname,
  manifest: MANIFEST,
  answer: (method, path, query, body, ticket) => answer(method, path, query, body, ticket),
  build: BUILD,
  ticket: TICKET,
  before: QUEUE_DOOR,
  /* The same paths as `vite.config.ts`: without them the built server answered 404 for the
     skill's text, so a host could not install /queue. */
  ours: (path) => path === '/healthz' || path === '/mcp' || path.startsWith('/api/') || isSkillPath(path),
  onStop: () => queue().stop(),
})
servingAt(running.origin)
queue()
