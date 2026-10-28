import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'kehikot-module-protocol'

import pkg from './package.json'
import { SETTINGS } from './queue/fields.ts'

/*
 * Who this module is. `bun run rename <name>` rewrites the id, the name, the
 * folder and the port the first time; after that they never change, because the
 * id names the folder its data is kept in (`<project>/.kehikot/queue/`).
 */
export const ID = 'kehikot.queue'
/** The module's version: package.json's, the one place it is written. A release is tagged with it. */
export const VERSION: string = pkg.version

/**
 * Where this module would like to answer while you run it yourself. Read by
 * `vite.config.ts` and `register.ts`. Modules on a machine sit ten apart, so a
 * drift up from one never lands on a neighbour's number; a host that installs
 * the module hands it a port of its own (`$PORT`).
 */
export const PREFERRED_PORT = 8110

/**
 * What this module says about itself, parsed when imported: a manifest no host
 * would accept fails here, in a test, rather than on somebody's canvas.
 *
 * What is served (`MANIFEST` in doors.ts) is this with `declares.skills` added,
 * because a skill's version follows the origin the process really serves on.
 */
export const DECLARED: Manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  protocol: PROTOCOL,
  id: ID,
  name: 'Test runs',
  /* The icon the official list gives it: Lucide's timer. */
  icon: 'lucide:timer',
  version: VERSION,
  /* The format of what this module keeps under `.kehikot/`. Raise it only in
     the release that first writes data an older release cannot read. */
  dataVersion: 1,
  summary: 'One queue for the heavy test runs every session on this computer asks for, started when there is room.',
  /* Where a host files this module in its list, most fitting first. The words are `TAGS` in the protocol. */
  tags: ['tests', 'agents'],
  /* Composed into every agent's prompt on the canvas: what this module's presence obliges an agent to do. */
  guidance:
    'This computer runs heavy test suites through Test runs, one queue for every session. Do not start a whole suite, a monorepo '
    + 'typecheck or a pre-push run directly: put it in the queue with `queue_run` (command, cwd, kind, label, ref) and wait for its '
    + 'result with `queue_wait` instead of polling the load. A failed run\'s answer has the end of its output.',
  entry: '/app',
  modes: [{ id: 'queue', label: 'Test runs', scope: 'global' }],
  mcp: {
    url: '/mcp',
    transport: 'http',
    about: 'Queue heavy test runs on this computer (queue_run), see the queue (queue_status), wait for a result (queue_wait), cancel your own (queue_cancel).',
  },
  extensions: { emits: [], consumes: [] },
  /* Runs are this computer's, not a part's: nothing to narrow. */
  partless: 'A test run is this computer\'s, for a change or an issue, never for a part of an epic.',
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    /* Only what is called. activity:report for `activity.set`: a finished run is in the Inbox, a failed one needs you.
       view:navigate for `view.goto`: the jump-into button on a run. */
    uses: ['activity:report', 'view:navigate'],
    /* True because this module takes writes (cancel, move): its page is framed on its real origin. */
    storage: true,
    prompt: false,
    settings: SETTINGS,
  },
  health: '/healthz',
})
