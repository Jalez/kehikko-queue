import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'kehikot-module-protocol'

import pkg from './package.json'
/* This module's introduction (protocol 2.57.0): slides the host shows in its introduction dialog. Also
   read as a file from the repository, so a person can watch it before the module runs or is installed. */
import intro from './intro.json'
import { SETTINGS } from './queue/fields.ts'

/** "How to use" (protocol 2.52.0). Each string one line of plain text. */
export const HELP = {
  summary: 'One queue for heavy work on this computer: test suites, builds and big installs from every session wait their turn and start when there is room.',
  sections: [
    {
      title: 'What it shows',
      points: [
        'At the top, three tiles: the queue (running and waiting), the strain on the computer against the limit above which new runs wait, and the latest results. A short container shows only these.',
        'Below, every run, grouped waiting, running and finished, with its kind: verify for tests, build, task for other heavy work, push for a pre-push hook, review.',
        'With more room, each run’s output, the session and epic it came from, the change it is for, and how long it waited and ran.',
      ],
    },
    {
      title: 'How to use it',
      points: [
        'Press a run to open it: its command, where it came from, its output, and Cancel.',
        'Move a waiting run up, down or to the top, or cancel any run that is no longer needed.',
        'Opening a run from Kehikot’s Inbox shows it here with its output open. Results are quiet news there and never ask for your attention.',
        'From a shell or a git hook, kehikot-queue run followed by a command queues it, waits its turn and exits with its exit code. If Queue is not running, it runs the command right there.',
        'Settings › Modules › Queue sets how many runs go at once, how busy the computer may be before new runs wait, and how long a run waits before it starts anyway.',
      ],
    },
    {
      title: 'What agents can do',
      points: [
        'queue_run puts a command in the queue and answers at once with its id; queue_wait waits for the result, and queue_status shows the queue or one run.',
        'queue_cancel cancels the runs of the agent’s own conversation, never another’s.',
        'When a run ends and nothing waits on it, the session that asked is told the result in one line.',
        'The /queue skill asks an agent to run this work’s tests, a build or another heavy command through the queue and report.',
      ],
    },
    {
      title: 'Rules',
      points: [
        'A push run, a pre-push hook a person waits on, goes before every other kind; otherwise first come, first served.',
        'A run’s pass or fail is its command’s own exit code. It runs in the folder it was asked in, with anything that looks like a secret left out of its environment.',
        'It never runs anything it was not asked to run. Cancelling and moving runs from the page are yours alone.',
      ],
    },
  ],
}

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
  name: 'Queue',
  /* The icon the official list gives it: Lucide's timer. */
  icon: 'lucide:timer',
  version: VERSION,
  /* The format of what this module keeps under `.kehikot/`. Raise it only in
     the release that first writes data an older release cannot read. */
  dataVersion: 1,
  summary: 'One queue for heavy work every session on this computer asks for (test suites, builds, other resource-intensive commands), started when there\'s room.',
  /* Where a host files this module in its list, most fitting first. The words are `TAGS` in the protocol. */
  tags: ['tests', 'build', 'agents'],
  /* Composed into every agent's prompt on the canvas: what this module's presence obliges an agent to do. */
  guidance:
    'This computer runs heavy work through Queue, one queue for every session. Do not start a whole test suite, a monorepo '
    + 'typecheck, a build, a big install or a pre-push run directly: put it in the queue with `queue_run` (command, cwd, kind — '
    + 'verify for tests, build, or task for anything else — label, ref, and preflight for a quick readiness check) and wait for '
    + 'its result as long as it takes: run the `kehikot-queue wait <id>` line it answers as a background shell command, or call '
    + '`queue_wait`; never poll the load. A failed run\'s answer has the end of its output. When nothing waits on a run as it '
    + 'ends, Kehikot types its result into the session that asked.',
  /* What every agent session is told about it (protocol 2.36.0): beside its name where it is on the
     kehikko, and — for a session on a kehikko it is NOT on, while it is installed here — the second. */
  agentSays: "Run heavy commands — tests, builds, big installs — through the Queue (queue_run, then its wait line as a background shell command) instead of in the shell, so sessions don't collide.",
  absentSays: "Don't start heavy commands (test suites, builds, big installs) directly. If the person insists, suggest adding Queue to this kehikko so runs don't collide.",
  /* "How to use" (protocol 2.52.0). */
  help: HELP,
  intro,
  entry: '/app',
  /* What its content belongs to (protocol 2.29.0): one mode per scope, the default first. */
  modes: [
    { id: 'queue', label: 'Queue', scope: 'machine', scopeSays: 'every project’s queued work on this computer, whatever is open here' },
    { id: 'here', label: 'This project', scope: 'project', scopeSays: 'this project’s queued work' },
  ],
  mcp: {
    url: '/mcp',
    transport: 'http',
    about: 'Queue heavy work on this computer — test suites, builds, other resource-intensive commands (queue_run), see the queue (queue_status), wait for a result (queue_wait), cancel your own (queue_cancel).',
  },
  extensions: { emits: [], consumes: [] },
  /* Runs are this computer's, not a part's: nothing to narrow. */
  partless: 'A queued run is this computer\'s, for a change or an issue, never for a part of an epic.',
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    /* Only what is called. activity:report for `activity.set`: every run of the last day is in the Inbox, quietly: nothing needs the person.
       view:navigate for `view.goto`: the jump-into button on a run.
       agents:message for `messages.notify` (protocol 2.54.0): a run's result told to the session that asked, when nothing waits on it. */
    uses: ['activity:report', 'view:navigate', 'agents:message'],
    /* The jump-into button's view.goto carries the run's project (when it is not the open one) and
       the session that asked for it (protocol 2.28.0): a host before 2.28 is not asked. */
    navigates: ['project', 'show'],
    /* True because this module takes writes (cancel, move): its page is framed on its real origin. */
    storage: true,
    prompt: false,
    settings: SETTINGS,
  },
  health: '/healthz',
})
