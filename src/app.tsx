import { ArrowDown, ArrowUp, Check, ChevronsUp, CircleCheck, CircleDashed, CircleSlash, CircleX, Copy, LoaderCircle, SquareArrowOutUpRight, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { navigationResult, type HeaderItem, type PressValue } from 'kehikot-module-protocol'
import { Cover, coverFor, useServerStanding } from 'kehikot-module-protocol/client/react'

import { HeaderMenus } from '@/components/header-menus'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { headerItems, pressed, showingOf, type Showing } from '@/header'
import { inboxItems } from '@/inbox'
import { api as realApi, type Api, type Overview } from '@/wire/api'
import { useKehikot, type Host } from '@/wire/use-kehikot'

import { jumpFor, originOf, type GotoParams } from '../queue/origin.ts'
import type { RunView } from '../queue/queue.ts'

type Press = { item: string; value?: PressValue }

/** The page: the queue as last read, at the container's scope (protocol 2.29.0). */
export function App() {
  const press = useCallback(({ item, value }: Press) => pressed(item, value), [])
  const host = useKehikot({ onPress: press })
  const items = useMemo(() => headerItems(), [])
  const { header } = host
  useEffect(() => header(items), [header, items])
  return <Screen host={host} items={items} onPress={press} />
}

export function Screen({
  host,
  api = realApi,
  items = headerItems(),
  showing: asked,
  onPress = () => {},
  now = () => Date.now(),
}: {
  host: Host
  api?: Api
  items?: HeaderItem[]
  showing?: Showing
  onPress?: (press: Press) => void
  now?: () => number
}) {
  const server = useServerStanding()
  /* Every project's runs at This computer (the default), the open project's at Project: the scope, said by the host. */
  const showing: Showing = asked ?? showingOf(host.workingScope, host.projectPath)
  /* The queue is this computer's: it is drawn with no project open too. */
  const cover = coverFor({ ...host, server }, { project: false })
  const [overview, setOverview] = useState<Overview | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  /* The run whose output the drawer shows: one at a time, by id. */
  const [open, setOpen] = useState<string | null>(null)
  const [jumpSaid, setJumpSaid] = useState<string | null>(null)
  const partName = useCallback((id: string) => host.parts.find((part) => part.id === id)?.heading || id, [host.parts])
  const jump = (run: RunView) => <JumpButton run={run} host={host} partName={partName} onSaid={setJumpSaid} />

  const read = useCallback(() => {
    api.runs().then(
      (got) => {
        setOverview(got)
        setSaid(null)
      },
      (error: unknown) => setSaid(error instanceof Error ? error.message : String(error)),
    )
  }, [api])

  /* Read when the server says the queue changed, never on a clock; the stream says so once as it
     opens, so this is also the first read, and again whenever the page is shown after being hidden. */
  useEffect(() => api.changes(read), [api, read])

  /* The Inbox: every run of the last day, filed under its own project; a failure needs the person. */
  const { activity } = host
  useEffect(() => {
    if (overview && host.where === 'hosted') activity(inboxItems(overview.runs, now()))
  }, [activity, overview, host.where, now])

  const act = (done: Promise<Overview>) =>
    done.then(
      (got) => {
        setOverview(got)
        setSaid(null)
      },
      (error: unknown) => setSaid(error instanceof Error ? error.message : String(error)),
    )

  const runs = useMemo(() => {
    const all = overview?.runs ?? []
    return showing === 'all' || !host.projectPath ? all : all.filter((run) => run.project === host.projectPath)
  }, [overview, showing, host.projectPath])

  /* The drawer's run is looked up by id in the whole queue, so it stays open while the list narrows or changes. */
  const opened = open ? overview?.runs.find((run) => run.id === open) : undefined
  const waiting = runs.filter((run) => run.state === 'queued')
  const running = runs.filter((run) => run.state === 'running')
  const finished = runs.filter((run) => run.state !== 'queued' && run.state !== 'running')

  return (
    <div className="flex h-screen min-w-0 flex-col text-sm">
      {host.where === 'unhosted' ? (
        <header className="flex min-h-9 shrink-0 items-center gap-2 border-b px-2">
          <span className="text-xs font-medium">Test runs</span>
          <HeaderMenus items={items} onPress={onPress} />
        </header>
      ) : null}
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        {cover ? (
          <Cover state={cover} name="Test runs" onRetry={read} />
        ) : (
          <>
            {overview ? <MachineLine overview={overview} /> : null}
            {jumpSaid ? (
              <p className="text-muted-foreground text-xs" role="status" data-testid="jump-said">
                {jumpSaid}
              </p>
            ) : null}
            {said ? (
              <p className="text-destructive text-xs" role="alert" data-testid="said">
                {said}
              </p>
            ) : null}
            {overview && !runs.length ? (
              <p className="text-muted-foreground text-xs" data-testid="empty">
                {showing === 'here' && host.projectPath ? 'No test runs for this project lately. Every project’s: pick This computer as the scope in its settings.' : 'No test runs lately.'}
              </p>
            ) : null}
            <Group title="Waiting" runs={waiting}>
              {(run, at) => (
                <RunRow key={run.id} run={run} now={now()} jump={jump(run)} onOutput={() => setOpen(run.id)}>
                  <Button variant="ghost" size="sm" className="size-6 p-0" aria-label={`Move “${run.label}” to the top`} disabled={at === 0} onClick={() => void act(api.move(run.id, 'top'))}>
                    <ChevronsUp className="size-3" />
                  </Button>
                  <Button variant="ghost" size="sm" className="size-6 p-0" aria-label={`Move “${run.label}” up`} disabled={at === 0} onClick={() => void act(api.move(run.id, 'up'))}>
                    <ArrowUp className="size-3" />
                  </Button>
                  <Button variant="ghost" size="sm" className="size-6 p-0" aria-label={`Move “${run.label}” down`} disabled={at === waiting.length - 1} onClick={() => void act(api.move(run.id, 'down'))}>
                    <ArrowDown className="size-3" />
                  </Button>
                  <Cancel run={run} onCancel={() => void act(api.cancel(run.id))} />
                </RunRow>
              )}
            </Group>
            <Group title="Running" runs={running}>
              {(run) => (
                <RunRow key={run.id} run={run} now={now()} jump={jump(run)} onOutput={() => setOpen(run.id)}>
                  <Cancel run={run} onCancel={() => void act(api.cancel(run.id))} />
                </RunRow>
              )}
            </Group>
            <Group title="Finished" runs={finished}>
              {(run) => <RunRow key={run.id} run={run} now={now()} jump={jump(run)} onOutput={() => setOpen(run.id)} />}
            </Group>
          </>
        )}
      </main>
      <Sheet open={opened !== undefined} onOpenChange={(next) => (next ? undefined : setOpen(null))}>
        {opened ? <RunDrawer run={opened} api={api} now={now()} jump={jump(opened)} jumpSaid={jumpSaid} /> : null}
      </Sheet>
    </div>
  )
}

function MachineLine({ overview }: { overview: Overview }) {
  const { machine } = overview
  return (
    <p className="text-muted-foreground text-xs" data-testid="machine">
      {machine.cores} cores · load {machine.load.toFixed(1)} · at most {machine.most} at once · nothing new above load {machine.loadAbove.toFixed(1)}, except after {machine.waitMinutes} min waiting · change in Kehikot’s Settings › Modules
    </p>
  )
}

function Group({ title, runs, children }: { title: string; runs: RunView[]; children: (run: RunView, at: number) => React.ReactNode }) {
  if (!runs.length) return null
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {title} ({runs.length})
      </h2>
      <ul className="flex flex-col gap-1">{runs.map((run, at) => children(run, at))}</ul>
    </section>
  )
}

const STATE_WORDS: Record<RunView['state'], string> = { queued: 'Waiting', running: 'Running', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled' }

function StateMark({ run }: { run: RunView }) {
  const Icon = run.state === 'passed' ? CircleCheck : run.state === 'failed' ? CircleX : run.state === 'cancelled' ? CircleSlash : run.state === 'running' ? LoaderCircle : CircleDashed
  const tone = run.state === 'passed' ? 'text-emerald-600 dark:text-emerald-400' : run.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium ${tone}`} data-state={run.state}>
      <Icon className={`size-3.5 ${run.state === 'running' ? 'animate-spin' : ''}`} aria-hidden />
      {STATE_WORDS[run.state]}
      {run.exit !== null && run.state !== 'passed' ? ` (exit ${run.exit})` : ''}
    </span>
  )
}

export function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/**
 * One run: what it is, where it came from, how long it waited and ran. Its output is in the drawer.
 * A run still waiting or running says since when rather than for how long: the page is redrawn when
 * the queue changes, not on a clock, and a duration would stand still between changes.
 */
function RunRow({ run, now, jump, onOutput, children }: { run: RunView; now: number; jump: React.ReactNode; onOutput: () => void; children?: React.ReactNode }) {
  const waited = run.state === 'queued' ? `waiting since ${clock(run.queuedAt)}` : `waited ${seconds((run.startedAt ?? run.finishedAt ?? now) - run.queuedAt)}`
  const ran = run.startedAt === null ? null : run.finishedAt === null ? `running since ${clock(run.startedAt)}` : `ran ${seconds(run.finishedAt - run.startedAt)}`
  return (
    <li className="rounded-md border px-2 py-1.5" data-run={run.id}>
      <div className="flex min-w-0 items-center gap-2">
        <StateMark run={run} />
        {/* A label is the asker's words: text, never markup. */}
        <span className="min-w-0 flex-1 truncate font-medium" title={run.argv.join(' ')}>
          {run.label}
        </span>
        <Badge variant="outline">{run.kind}</Badge>
        {jump}
        {children}
      </div>
      <p className="text-muted-foreground mt-0.5 text-xs break-words">
        {run.state === 'queued' && run.waiting ? `${run.waiting} ` : ''}
        From {run.asker.said}
        {run.epic ? ` · epic ${run.epic}` : ''}
        {run.refs.length ? ` · for ${run.refs.join(', ')}` : ''} · {waited}
        {ran !== null ? ` · ${ran}` : ''}
        {run.why ? ` · ${run.why}` : ''}
      </p>
      {run.state !== 'queued' ? (
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" aria-haspopup="dialog" aria-label={`Output of “${run.label}”`} onClick={onOutput}>
          Output
        </Button>
      ) : null}
    </li>
  )
}

/**
 * The jump-into button: asks the host to show the place the run was asked for from (`view.goto`).
 * Disabled, with the reason in its tooltip, when there is no place to go to. The tooltip is on the
 * wrapper, because a disabled button takes no pointer.
 */
function JumpButton({ run, host, partName, onSaid }: { run: RunView; host: Host; partName: (id: string) => string; onSaid: (said: string | null) => void }) {
  const jump = jumpFor(run, { path: host.projectPath ?? null, id: host.projectId ?? null }, partName)
  const go = async (params: GotoParams) => {
    try {
      const got = navigationResult.safeParse(await host.request('view.goto', { ...params }))
      if (got.success && got.data.outcome === 'moved') onSaid(null)
      else if (got.success) onSaid(got.data.why || (got.data.outcome === 'no-such-target' ? 'Kehikot has no such place any more.' : 'Kehikot would not go there now.'))
      else onSaid('Kehikot did not say whether it went.')
    } catch (error) {
      onSaid(error instanceof Error && error.message ? error.message : 'Kehikot did not answer.')
    }
  }
  return (
    <span title={jump.words} className="inline-flex shrink-0" data-testid="jump-tip">
      <Button variant="ghost" size="sm" className="size-6 p-0" aria-label="Go to where this run came from" disabled={!jump.goto} onClick={() => (jump.goto ? void go(jump.goto) : undefined)}>
        <SquareArrowOutUpRight className="size-3" />
      </Button>
    </span>
  )
}

const clock = (ms: number | null) => (ms === null ? 'not yet' : new Date(ms).toLocaleTimeString())

/** One run in the drawer: what it is, when, where from, and its output. One at a time. */
function RunDrawer({ run, api, now, jump, jumpSaid }: { run: RunView; api: Api; now: number; jump: React.ReactNode; jumpSaid: string | null }) {
  const origin = originOf(run)
  /* Only once it has finished: while it runs, "started" above says since when (nothing redraws on a clock). */
  const ran = run.startedAt === null || run.finishedAt === null ? null : run.finishedAt - run.startedAt
  return (
    <SheetContent aria-describedby="run-drawer-about" data-testid="drawer" data-run={run.id}>
      <SheetTitle>{run.label}</SheetTitle>
      <SheetDescription id="run-drawer-about" asChild>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <StateMark run={run} />
            <Badge variant="outline">{run.kind}</Badge>
            {jump}
          </div>
          <p data-testid="drawer-times">
            Asked {clock(run.queuedAt)} · started {clock(run.startedAt)} · {run.finishedAt === null ? 'not finished' : `finished ${clock(run.finishedAt)}`}
            {ran !== null ? ` · ran ${seconds(ran)}` : ''}
          </p>
          <p className="break-words" data-testid="drawer-origin">
            From {run.asker.said}
            {origin?.epic ? ` · epic ${origin.epic}` : ''}
            {origin?.branch ? ` · branch ${origin.branch}` : ''}
          </p>
          {run.why ? <p>{run.why}</p> : null}
          {jumpSaid ? <p role="status">{jumpSaid}</p> : null}
        </div>
      </SheetDescription>
      <OutputOf key={run.id} run={run} api={api} />
    </SheetContent>
  )
}

function Cancel({ run, onCancel }: { run: RunView; onCancel: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="size-6 p-0" aria-label={`Cancel “${run.label}”`} onClick={onCancel}>
      <X className="size-3" />
    </Button>
  )
}

/** What `capLog` writes where it cut a log short. */
const CUT_MARK = 'bytes of output left out here'
const TEXT_MOST = 200_000

/**
 * A run's output as captured (stdout and stderr together), read as it grows while the run runs and
 * kept scrolled to its end then. Drawn as text. Keyed by run id by its parent, so another run starts clean.
 */
export function OutputOf({ run, api }: { run: RunView; api: Api }) {
  const [text, setText] = useState('')
  const [cut, setCut] = useState(false)
  const [copied, setCopied] = useState(false)
  const next = useRef(0)
  const scroller = useRef<HTMLPreElement>(null)
  const live = run.state === 'running'
  useEffect(() => {
    let gone = false
    /* One read at a time: news that arrives during a read asks for one more after it, so no byte is read twice. */
    let reading = false
    let again = false
    const more = (): void => {
      if (reading) {
        again = true
        return
      }
      reading = true
      again = false
      void api.output(run.id, next.current).then(
        (got) => {
          reading = false
          if (gone) return
          if (got.text) {
            next.current = got.next
            setText((was) => {
              const all = was + got.text
              if (all.length > TEXT_MOST) setCut(true)
              return all.slice(-TEXT_MOST)
            })
          }
          if ((got.text && got.next < got.size) || again) more()
        },
        () => {
          reading = false
        },
      )
    }
    /* While it runs, read as the server says its log grew (and once as that stream opens); a run that
       has ended is read once. */
    const stop = live ? api.outputChanges(run.id, more) : (more(), () => {})
    return () => {
      gone = true
      stop()
    }
  }, [api, run.id, live])
  useEffect(() => {
    const box = scroller.current
    if (live && box) box.scrollTop = box.scrollHeight
  }, [text, live])
  const copy = () => {
    const done = () => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(text).then(done, () => {})
  }
  const truncated = cut || text.includes(CUT_MARK)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" disabled={!text} onClick={copy}>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {truncated ? (
          <a className="text-primary text-xs underline underline-offset-4" href={`./api/log?id=${encodeURIComponent(run.id)}`} target="_blank" rel="noreferrer">
            Open full log
          </a>
        ) : null}
      </div>
      <pre
        ref={scroller}
        tabIndex={0}
        className="bg-muted min-h-24 flex-1 overflow-auto rounded p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap"
        data-testid="output"
        aria-label={`Output of “${run.label}”`}
      >
        {text || (live ? 'Nothing printed yet.' : 'It printed nothing.')}
      </pre>
    </div>
  )
}
