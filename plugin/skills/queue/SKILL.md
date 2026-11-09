---
name: queue
description: Run this work's tests, a build or another heavy command through Kehikot's Queue instead of starting it now, and report the result. Only a person runs it, by typing /queue.
disable-model-invocation: true
allowed-tools: Bash(curl:*), Bash('{{cli}}' wait:*), mcp__queue__queue_run, mcp__queue__queue_wait, mcp__queue__queue_status
---

The person typed `/queue $ARGUMENTS`. Kehikot's Queue module answers at {{origin}}. Whether it is up, then curl's own report in brackets:

!`curl -s -m 5 -w '\n[curl exit %{exitcode}; HTTP %{http_code}]\n' {{origin}}/healthz || echo "[no answer from {{origin}}]"`

If the answer above does not name `kehikot.queue`, or you have no `mcp__queue__queue_run` tool, tell the person in one line: "Kehikot: couldn't reach the Queue module at {{origin}}. Open Queue on a kehikko and turn its tools on in Kehikot's Settings › Module tools, then try /queue again. [skill {{version}}]" — and stop.

Otherwise:

1. Decide the command: what the person typed after /queue (tests, a build, an install, any heavy command), else this repository's own test command (its `package.json` `test` script, its CLAUDE.md, its CI). Run it in the folder you are working in (`cwd`), as one line for the shell.
2. Call `queue_run` with `command`, `cwd`, `kind` — `"verify"` for tests and checks, `"build"` for a build, `"task"` for anything else — a short `label` a person recognises ("bun test", "typecheck", "vite build"), and `ref` when you know the change or issue this work is for ("!3907", "gh#12"). When a quick command would show the folder is not ready (dependencies, tool trust), pass it as `preflight`. If the answer says "Not queued", fix what it says and ask again; a "Would fail" line is worth fixing before the run reaches the front.
3. Wait for it as long as it takes. If you have a Bash tool that can run a command in the background (Claude Code: `run_in_background: true`), run the command line `queue_run` answered — `'{{cli}}' wait <id>` — that way, and wait for it to finish: you are woken when it exits, with the run's output and its exit code. Do not run it in the foreground (a foreground command is stopped after a few minutes), do not poll the machine's load, and do not start the command yourself meanwhile. Without a background Bash, call `queue_wait` with the id until it has ended (call it again while it says it is not finished).
4. Tell the person in a few lines: passed or failed, the exit code, how long it waited and ran. On a failure, quote the lines of output that say what failed and read them before retrying: a run that went through the queue did not fail for want of room. If its result says it failed at once because of the folder, fix that before queueing again.
