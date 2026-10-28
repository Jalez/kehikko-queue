---
name: queue
description: Run this work's tests through Kehikot's Test runs queue instead of starting them now, and report the result. Only a person runs it, by typing /queue.
disable-model-invocation: true
allowed-tools: Bash(curl:*), mcp__queue__queue_run, mcp__queue__queue_wait, mcp__queue__queue_status
---

The person typed `/queue $ARGUMENTS`. Kehikot's Test runs module answers at {{origin}}. Whether it is up, then curl's own report in brackets:

!`curl -s -m 5 -w '\n[curl exit %{exitcode}; HTTP %{http_code}]\n' {{origin}}/healthz || echo "[no answer from {{origin}}]"`

If the answer above does not name `kehikot.queue`, or you have no `mcp__queue__queue_run` tool, tell the person in one line: "Kehikot: couldn't reach the Test runs module at {{origin}}. Open Test runs on a kehikko and turn its tools on in Kehikot's Settings › Module tools, then try /queue again. [skill {{version}}]" — and stop.

Otherwise:

1. Decide the command: what the person typed after /queue, else this repository's own test command (its `package.json` `test` script, its CLAUDE.md, its CI). Run it in the folder you are working in (`cwd`), as one line for the shell.
2. Call `queue_run` with `command`, `cwd`, `kind: "verify"`, a short `label` a person recognises ("bun test", "typecheck"), and `ref` when you know the change or issue this work is for ("!3907", "gh#12").
3. Call `queue_wait` with the id until it has ended (call it again while it says it is not finished). Do not poll the machine's load and do not start the command yourself meanwhile.
4. Tell the person in a few lines: passed or failed, the exit code, how long it waited and ran. On a failure, quote the lines of output that say what failed and read them before retrying: a run that went through the queue did not fail for want of room.
