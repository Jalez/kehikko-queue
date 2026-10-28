import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'kehikot-module-protocol'

import pkg from './package.json'

/*
 * Who this module is. `bun run rename <name>` rewrites the id, the name, the
 * folder and the port the first time; after that they never change, because the
 * id names the folder its data is kept in (`<project>/.kehikot/example/`).
 */
export const ID = 'kehikot.example'
/** The module's version: package.json's, the one place it is written. A release is tagged with it. */
export const VERSION: string = pkg.version

/**
 * Where this module would like to answer while you run it yourself. Read by
 * `vite.config.ts` and `register.ts`. Modules on a machine sit ten apart, so a
 * drift up from one never lands on a neighbour's number; a host that installs
 * the module hands it a port of its own (`$PORT`).
 */
export const PREFERRED_PORT = 9500

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
  name: 'Example',
  version: VERSION,
  /* The format of what this module keeps under `.kehikot/`. Raise it only in
     the release that first writes data an older release cannot read. */
  dataVersion: 1,
  summary: 'Short notes about the epic you are working on, filed under the parts you picked.',
  /* Where a host files this module in its list, most fitting first. The words are `TAGS` in the protocol. */
  tags: ['notes'],
  /* Composed into every agent's prompt on the canvas: what this module's presence obliges an agent to do. */
  guidance:
    'This canvas has Example on it: short notes about the epic, each filed under the parts that were picked when it was written. '
    + 'Read them with `list_notes` before you change what they talk about. You cannot add, finish or remove a note: that is the person\'s.',
  entry: '/app',
  modes: [{ id: 'example', label: 'Example', scope: 'epic' }],
  mcp: {
    url: '/mcp',
    transport: 'http',
    about: 'Read the notes a person keeps about an epic in Example. Read-only.',
  },
  extensions: { emits: [], consumes: [] },
  /* parts: every note is anchored to the parts picked when it was written, and the list narrows to the parts picked now. */
  reacts: ['parts'],
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    /* Only what is called. activity:report for `activity.set`: an open note is in the person's Inbox. */
    uses: ['activity:report'],
    /* True because this module keeps material and takes writes: the host frames it on its real
       origin, so its `/api` calls are same-origin and need no permissive CORS header. */
    storage: true,
    prompt: false,
  },
  health: '/healthz',
})
