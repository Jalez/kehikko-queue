/**
 * A run that holds its slot and does nothing (issue #48): its process tree has used almost no CPU for
 * several minutes. A text check of the command cannot catch every such wait (a script file, a
 * language-level sleep, a stuck network call), so the queue also looks at what the run DOES.
 *
 * It is only ever FLAGGED: the Queue page and `queue_status` say "idle in its slot" with how long and
 * leave the person (or the session that asked) to cancel it. The queue never kills or requeues a run on
 * its own: a long download or a test run waiting on a slow network looks the same from here, and a
 * silent kill would lose work.
 *
 * What is kept is each running run's CPU seconds per process, in memory; a restart of the queue starts
 * the look again, so a flag is never older than the queue's own memory. Pure, and free of node's own modules: the page imports `idleSaid` (`queue/idle-ps.ts` has the one that runs `ps`).
 */

/** How long the tree must have used almost nothing before the run is flagged. */
export const IDLE_MS = 5 * 60_000
/** "Almost nothing": at most this share of ONE core, averaged over each look. */
export const IDLE_SHARE = 0.02
/** The most often the processes are looked at. */
export const SAMPLE_EVERY_MS = 15_000

/** CPU seconds used so far, by process id, for the whole tree of one run. */
export type Cpu = ReadonlyMap<number, number>

/** What is kept of one run between looks. */
export interface Watch {
  at: number
  cpu: Cpu
  /** Since when the tree has used almost nothing, or null while it is working. */
  quietSince: number | null
}

/**
 * The next look, given the last. What the tree used between two looks is what each process still
 * there used more (a process new since then counts what it has used so far; one that has gone counts
 * nothing: a polling loop's short-lived `sleep` and `awk` use next to nothing either way). Working
 * at any look ends the quiet; quiet from that look on otherwise.
 */
export function look(was: Watch | null, cpu: Cpu, at: number): Watch {
  if (!was) return { at, cpu, quietSince: null }
  const seconds = (at - was.at) / 1000
  if (seconds <= 0) return { ...was }
  let used = 0
  for (const [pid, now] of cpu) used += Math.max(0, now - (was.cpu.get(pid) ?? 0))
  const quiet = used / seconds <= IDLE_SHARE
  return { at, cpu, quietSince: quiet ? (was.quietSince ?? was.at) : null }
}

/** Since when a run has been idle in its slot, or null when it is not (yet) for long enough. */
export const idleSince = (watch: Watch | null, at: number, forMs = IDLE_MS): number | null => (watch && watch.quietSince !== null && at - watch.quietSince >= forMs ? watch.quietSince : null)

/** `[[dd-]hh:]mm:ss[.cc]`, as `ps -o cputime` prints it, in seconds. NaN when not that. */
export function cpuSeconds(text: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim())
  if (!match) return Number.NaN
  const [, days, hours, minutes, seconds] = match
  return Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
}

/** One run's tree out of `ps -axo pid=,ppid=,pgid=,cputime=` output: the run's own group and everything below it. */
export function treeOf(psOutput: string, root: number): Cpu {
  const rows: { pid: number; ppid: number; pgid: number; cpu: number }[] = []
  for (const line of psOutput.split('\n')) {
    const [pid, ppid, pgid, time] = line.trim().split(/\s+/)
    if (!time) continue
    const cpu = cpuSeconds(time)
    if (Number.isNaN(cpu)) continue
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), cpu })
  }
  const inside = new Set<number>(rows.filter((row) => row.pid === root || row.pgid === root).map((row) => row.pid))
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) if (!inside.has(row.pid) && inside.has(row.ppid)) (inside.add(row.pid), (grew = true))
  }
  return new Map(rows.filter((row) => inside.has(row.pid)).map((row) => [row.pid, row.cpu]))
}

/** What the queue asks to know: the CPU of the trees of these pids, or null for all when it could not look. */
export type Sampler = (roots: readonly number[]) => Promise<Map<number, Cpu> | null>

/** What a person reads: "It has used almost no CPU for 7 min, so it may be waiting or stuck. Cancel it if it should not hold a slot." */
export function idleSaid(since: number, now: number): string {
  const minutes = Math.max(1, Math.round((now - since) / 60_000))
  return `Idle in its slot: its processes have used almost no CPU for ${minutes} min, so it may be sleeping, waiting or stuck while it holds a slot others wait for. Cancel it if it should not hold one.`
}
