import { ArrowDown, ArrowUp, ChevronsUp, CircleCheck, CircleDashed, CircleSlash, CircleX, LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { HeaderItem, PressValue } from 'kehikot-module-protocol'
import { Cover, coverFor, useServerStanding } from 'kehikot-module-protocol/client/react'

import { HeaderMenus } from '@/components/header-menus'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { headerItems, pressed, type Showing } from '@/header'
import { inboxItems } from '@/inbox'
import { api as realApi, type Api, type Overview } from '@/wire/api'
import { useKehikot, type Host } from '@/wire/use-kehikot'

import type { RunView } from '../queue/queue.ts'

type Press = { item: string; value?: PressValue }

/** The page: the header switch's state, and the queue as last read. */
export function App() {
  const [showing, setShowing] = useState<Showing>('here')
  const press = useCallback(({ item, value }: Press) => {
    const view = pressed(item, value)
    if (view !== 'here' && view !== 'all') return view
    setShowing(view)
  }, [])
  const host = useKehikot({ onPress: press })
  const items = useMemo(() => headerItems(showing), [showing])
  const { header } = host
  useEffect(() => header(items), [header, items])
  return <Screen host={host} items={items} showing={showing} onPress={press} />
}

/** How often the page reads the queue: often while something waits or runs, seldom otherwise. */
export const BUSY_MS = 2000
export const IDLE_MS = 15000

export function Screen({
  host,
  api = realApi,
  items = headerItems('here'),
  showing = 'here',
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
  /* The queue is this computer's: it is drawn with no project open too. */
  const cover = coverFor({ ...host, server }, { project: false })
  const [overview, setOverview] = useState<Overview | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const read = useCallback(() => {
    api.runs().then(
      (got) => {
        setOverview(got)
        setSaid(null)
      },
      (error: unknown) => setSaid(error instanceof Error ? error.message : String(error)),
    )
  }, [api])

  const busy = !!overview?.runs.some((run) => run.state === 'queued' || run.state === 'running')
  useEffect(() => {
    read()
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') read()
    }, busy ? BUSY_MS : IDLE_MS)
    return () => clearInterval(timer)
  }, [read, busy])

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
            {said ? (
              <p className="text-destructive text-xs" role="alert" data-testid="said">
                {said}
              </p>
            ) : null}
            {overview && !runs.length ? (
              <p className="text-muted-foreground text-xs" data-testid="empty">
                {showing === 'here' && host.projectPath ? 'No test runs for this project lately. Every project: Show › Every project.' : 'No test runs lately.'}
              </p>
            ) : null}
            <Group title="Waiting" runs={waiting}>
              {(run, at) => (
                <RunRow key={run.id} run={run} now={now()} open={open === run.id} onOpen={() => setOpen(open === run.id ? null : run.id)} api={api}>
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
                <RunRow key={run.id} run={run} now={now()} open={open === run.id} onOpen={() => setOpen(open === run.id ? null : run.id)} api={api}>
                  <Cancel run={run} onCancel={() => void act(api.cancel(run.id))} />
                </RunRow>
              )}
            </Group>
            <Group title="Finished" runs={finished}>
              {(run) => <RunRow key={run.id} run={run} now={now()} open={open === run.id} onOpen={() => setOpen(open === run.id ? null : run.id)} api={api} />}
            </Group>
          </>
        )}
      </main>
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

/** One run: what it is, where it came from, how long it waited and ran, and its output on demand. */
function RunRow({ run, now, open, onOpen, api, children }: { run: RunView; now: number; open: boolean; onOpen: () => void; api: Api; children?: React.ReactNode }) {
  const waited = (run.startedAt ?? (run.state === 'queued' ? now : run.finishedAt ?? now)) - run.queuedAt
  const ran = run.startedAt === null ? null : (run.finishedAt ?? now) - run.startedAt
  /* A failed run's output is open until the person closes it; any other's is closed until opened. */
  const shown = run.state !== 'queued' && open !== (run.state === 'failed')
  return (
    <li className="rounded-md border px-2 py-1.5" data-run={run.id}>
      <div className="flex min-w-0 items-center gap-2">
        <StateMark run={run} />
        {/* A label is the asker's words: text, never markup. */}
        <span className="min-w-0 flex-1 truncate font-medium" title={run.argv.join(' ')}>
          {run.label}
        </span>
        <Badge variant="outline">{run.kind}</Badge>
        {children}
      </div>
      <p className="text-muted-foreground mt-0.5 text-xs break-words">
        {run.state === 'queued' && run.waiting ? `${run.waiting} ` : ''}
        From {run.asker.said}
        {run.epic ? ` · epic ${run.epic}` : ''}
        {run.refs.length ? ` · for ${run.refs.join(', ')}` : ''} · waited {seconds(waited)}
        {ran !== null ? ` · ran ${seconds(ran)}` : ''}
        {run.why ? ` · ${run.why}` : ''}
      </p>
      {run.state !== 'queued' ? (
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" aria-expanded={shown} onClick={onOpen}>
          {shown ? 'Hide output' : 'Show output'}
        </Button>
      ) : null}
      {shown ? <OutputOf run={run} api={api} /> : null}
    </li>
  )
}

function Cancel({ run, onCancel }: { run: RunView; onCancel: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="size-6 p-0" aria-label={`Cancel “${run.label}”`} onClick={onCancel}>
      <X className="size-3" />
    </Button>
  )
}

/** A run's output, read as it grows while the run runs. Drawn as text. */
export function OutputOf({ run, api }: { run: RunView; api: Api }) {
  const [text, setText] = useState('')
  const next = useRef(0)
  const live = run.state === 'running'
  useEffect(() => {
    let gone = false
    const more = () =>
      api.output(run.id, next.current).then(
        (got) => {
          if (gone || !got.text) return
          next.current = got.next
          setText((was) => (was + got.text).slice(-200_000))
          if (got.next < got.size) void more()
        },
        () => {},
      )
    void more()
    const timer = live ? setInterval(() => void more(), 1000) : null
    return () => {
      gone = true
      if (timer) clearInterval(timer)
    }
  }, [api, run.id, live])
  return (
    <pre className="bg-muted mt-1 max-h-72 overflow-auto rounded p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap" data-testid="output" aria-label={`Output of “${run.label}”`}>
      {text || (live ? 'Nothing printed yet.' : 'It printed nothing.')}
    </pre>
  )
}
