# Test runs — notes for agents

A Kehikot module: a program with its own server, page and MCP door that a
Kehikot host frames in a container. The whole guide is
[Building a module](https://github.com/Jalez/kehikko-protocol/blob/main/docs/building-a-module.md);
what follows is how THIS repository is built, and the rules a change here keeps.

## Where things are

| | |
|---|---|
| `manifest.ts` | Who the module is. `DECLARED`; the version is package.json's. |
| `queue/schedule.ts` | When a run starts: capacity, load guard, starvation bound, priority, the person's moves. Pure. |
| `queue/queue.ts` | The queue: runs, their states, what is kept on disk, picking up running runs after a restart. |
| `queue/runner.ts` | Spawning in its own process group, the exit-file wrapper, logs (capped), cancel. |
| `queue/cli-door.ts` | The CLI's door and the fence in front of `/mcp` (a `before`: it needs the headers). |
| `queue/env.ts`, `queue/asks.ts` | What of a caller's environment a run gets; what a caller may ask. |
| `queue/settings.ts`, `queue/machine.ts` | Capacity settings (Settings › Modules); the machine folder and the CLI token. |
| `doors.ts` | `/healthz`, `/mcp` (queue_run/status/wait/cancel), the page's `/api/*`, the settings door. |
| `queue/origin.ts`, `queue/origin-find.ts` | Where a run came from (kept on the run, no environment) and what the jump-into button does with it (`view.goto`, project open only). |
| `store.ts` | The only write into a project: run results, `.kehikot/queue/runs.json`. |
| `bin/kehikot-queue(.ts)`, `hooks/pre-push` | The CLI for shells and hooks; the hook snippet. |
| `src/app.tsx`, `src/inbox.ts`, `src/header.ts` | The page, the Inbox items, the header switch. |
| `serve.ts`, `build.ts` | The built page on Bun (ready-built); Vite in a checkout. Both take `isOurs` from `doors.ts`: add a path there, never in one of them (`test/serves.test.ts`). |

## The rules

- **Storage.** A project's data lives only under `<project>/.kehikot/<folder>/`,
  built with the protocol's `moduleDir`/`moduleFile` in `store.ts`. No `data/`
  folder, nothing under the home folder, nothing beside the code.
  `test/storage-boundary.test.ts` and Kehikot's `check:storage` both fail on it.
- **The header is the host's to draw.** Declare items (`src/header.ts`), handle
  presses in one handler, own all the state, and declare the whole list again on
  every change. It is one row at 380, 280 and 200 pixels: short labels (`LABEL_FIT`).
- **A module's strings are text.** Labels, notes and reasons are drawn as text,
  never as markup or links.
- **Page-only writes.** Every write to the page's `/api` carries the page's ticket
  (`refuseTicket`).
- **This module runs commands.** Only what a caller asked, as an argv. The CLI door and `/mcp`
  answer programs only (no `Origin`, no `Sec-Fetch-Site`), the CLI door only with the 0600 token.
  Never log or write down a run's environment. Never widen these; a test holds each.
- **Code runs under Node (Vite) and Bun (`serve.ts`).** Use `node:` APIs on the server, never `Bun.*`.
- **Agents never press what is a person's.** `agents: true` goes only on a
  harmless switch, toggle or jump; never on a run that writes, sends or
  deletes, never on a `confirm` run.
- **The Inbox is one record.** Report what needs the person with
  `host.activity(items)`, whole, every time it changes; keep no list of
  notices of your own.
- **Ask only for what is called.** Each method needs its capability in
  `declares.uses`; nothing else goes there.
- **Kehikot says when it and the module do not fit.** Write no code for this.
  From protocol 2.22.0 Kehikot compares the manifest (`declares.uses`, the
  declarations, the protocol range) with its own protocol, and draws "<Module>
  needs a newer Kehikot" or "<Module> needs an update" in the container, with
  the button that fixes it. Keep `declares.uses` true, and the notice will be
  too. A call the host is too old for comes back `host-too-old`; you may show
  `FIT_SAYS.tooOld(since)` beside the control, after
  `hostTooOld(error)` (`kehikot-module-protocol/client`).
- **Plain language.** Every sentence a person reads says what happened and
  what to do, in their words: no ids, codes or stack traces.

## Working on it

```
bun test && bun run typecheck   # before every commit
bun run check:door              # what the MCP door says about its tools
bun run check:parts             # how the module follows the parts of an epic
bun run stub                    # look at it, framed, without Kehikot
```

Write the test first. Starting `./run.sh` or `bun run dev` from a checkout
registers that checkout with Kehikot on this computer when nothing else is
registered under the id; `bun run stub` never does.

## Releasing

Kehikot installs and updates this module from its GitHub releases, not from `main`.

1. Bump `version` in `package.json` (semver). It is the only place the version
   is written: the manifest reads it.
2. Write `notes/<version>.md`: what a person notices (see `notes/README.md`).
3. Open a PR with both; merge it.
4. Tag the merge commit on `main` with an annotated tag and push it:
   `git tag -a v<version> -m v<version> <merge-commit> && git push origin v<version>`.
5. `.github/workflows/release.yml` checks that the tag matches `package.json`
   and is on `main`, checks the notes, typechecks and tests, then publishes the
   release "Test runs <version>". If a check fails nothing is published: fix it on
   `main`, then tag again.
