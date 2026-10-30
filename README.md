# Test runs — a Kehikot module

One queue for the heavy test runs every session on this computer asks for. Several Claude Code
sessions, each in its own worktree, each running a whole suite before a push or after a fix, used to
start at once and starve each other until timing-sensitive tests failed for no reason. Now each run
waits in Test runs and starts when there is room; whoever asked waits for its own result.

- **When a run starts.** At most a few at once (Settings › Modules › Test runs › *Runs at once*;
  automatic is one per six cores, 2 on a 12-core Mac). No new run starts while the 1-minute load is
  above *Busy above* per core (0.75: 9 on 12 cores), but a run that has waited *Start anyway after*
  (10 minutes) starts as soon as a slot is free, oldest first, so nothing waits forever.
- **Who goes first.** A `push` (a pre-push hook a person is waiting on) before `verify`, `review` and
  `other`; first come first served within each. You can move a waiting run up, down or to the top,
  and cancel any run, on the page.
- **What you see.** Waiting, running and finished runs, each with the session and epic it came from,
  the change or issue it is for, how long it waited and ran, and its result. A failed run opens its output.
- **The Inbox.** Every run of the last day is in Kehikot's Inbox under its project: a failure needs
  you, a pass is done.
- **Run results for other modules.** Each project's runs are published as the protocol's run results
  (2.27.0), so a module showing a change can show whether its tests pass, without either naming the other.
- **Pass or fail is the command's own.** The command runs as given, in the folder it was asked in,
  with the caller's environment less anything that looks like a secret, and its exit code passes
  through unchanged.

## From a shell or a git hook: `kehikot-queue`

```
kehikot-queue run --kind push --label "pre-push monorepo" --ref '!3907' -- bun run check
kehikot-queue status
```

It queues the command, prints its place in the queue while it waits, prints the output as it runs,
and exits with the command's exit code. Ctrl-C cancels the run. **If Test runs is not running** (or
cannot take the run), it runs the command right there and says so, so a hook never breaks.

Options: `--kind push|verify|review|other`, `--label TEXT`, `--ref REF` (repeatable; `!3907`, `#12`,
`gh#12`), `--epic SLUG`, `--place TOKEN` (or `KEHIKOT_PLACE`: a session's Kehikot place, so the run
is filed under its epic), `--keep-env NAME` (keep a variable that looks like a secret, e.g. a token
a test needs), `--from TEXT` (who is asking, e.g. "pre-push hook").

**Install it** (once, your choice; it needs `bun`): link the script onto your PATH from wherever
Test runs is on this computer —

```
# Installed by Kehikot:
ln -s "$HOME/Library/Application Support/Kehikot/installed/kehikot.queue/bin/kehikot-queue" ~/.local/bin/kehikot-queue
# Or from a checkout of this repository:
ln -s "$PWD/bin/kehikot-queue" ~/.local/bin/kehikot-queue
```

**A pre-push hook** that uses it is in [`hooks/pre-push`](hooks/pre-push). Nothing installs it for
you. Per repository:

```
cp hooks/pre-push <repo>/.git/hooks/pre-push && chmod +x <repo>/.git/hooks/pre-push
# then set CHECKS in it to that repository's own command
```

The hook still runs before the push goes out: git waits for it, it waits for the queue, and the push
goes out only when the checks pass. Without `kehikot-queue` on PATH the hook runs the checks directly.
The command gets no input (a pre-push hook's list of refs on stdin is not passed on).

## From an agent: the MCP door

- `queue_run` — `command` (an array of words, or one line for the person's login shell), `cwd`,
  `kind`, `label`, `ref`; answers an id and a key at once. The session and epic come from the
  conversation's place (`?kehikot-place=` on the door's URL).
- `queue_status` — the queue, or one run.
- `queue_wait` — waits up to `timeout_seconds` (240, at most 1800) and answers passed or failed, the
  exit code, the times and the end of the output (more of it for a failure).
- `queue_cancel` — your own runs: those of this conversation's place, or with the key.

`/queue` (a skill) asks an agent to run this work's tests through the queue and report.

## Safety

This module runs commands, so its doors are strict. It never runs anything it was not asked to run.

- **The CLI's door** (`/api/queue/*`) answers only a program on this computer. Any `Origin` or
  `Sec-Fetch-Site` is refused, including this module's own page. It also needs the token in
  `<queue folder>/token`, a 0600 file only you can read.
- **The MCP door** (`/mcp`) answers only programs too. A POST from any page is refused before the
  protocol's doors see it.
- **Every door** refuses a `Host` that is not this machine's (DNS rebinding).
- **Cancelling and moving runs from the page** are the person's acts: they need the page's ticket.
- **The environment** a run gets is never written down or logged. It is held in memory until the
  run starts.

## Data

- `<project>/.kehikot/queue/runs.json`: the project's runs as run results (the protocol's
  `runs.json`), with a `.gitignore` beside it. Written only into a folder that is already a Kehikot
  project.
- `~/Library/Application Support/Kehikot/queue/` on macOS, `$XDG_DATA_HOME/kehikot/queue/` (default
  `~/.local/share/kehikot/queue/`) elsewhere, or `KEHIKOT_QUEUE_DIR`; this computer's:
  - `runs.json`: the queue and the finished runs, without environments.
  - `settings.json`: capacity.
  - `token`: the CLI's token.
  - `logs/<id>.log`: output, capped at 8 MB (head and tail kept).
  - `exit/<id>`: exit codes.

  Finished runs and their logs go after 7 days, or beyond the newest 300.

A run that is **running** when Test runs stops (an update restarts it) carries on in its own process
group, and is picked up again at the next start with its exit code. A run still **waiting** then is
ended as cancelled, because its environment was only in memory. The CLI then runs it directly.

## Development

```
bun test && bun run typecheck
bun run build && bun run start   # the built page, as Kehikot runs an installed copy
bun run stub                     # look at it, framed, without Kehikot
```

How it is built and the rules a change keeps: [CLAUDE.md](CLAUDE.md).
