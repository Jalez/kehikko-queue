import { ArrowDown, ArrowUp, Check, ChevronsUp, CircleCheck, CircleDashed, CircleSlash, CircleX, Copy, LoaderCircle, SquareArrowOutUpRight, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { navigationResult, settingsOpenResult, type HeaderItem, type PressValue } from 'kehikot-module-protocol'
import { Cover, coverFor, useServerStanding } from 'kehikot-module-protocol/client/react'

import { Glance } from '@/components/glance'
import { HeaderMenus } from '@/components/header-menus'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { footerItems } from '@/footer'
import { headerItems, pressed, showingOf, type Showing } from '@/header'
import { atLeast, levelOf, unreachableSaid, type Box, type Level } from '@/glance'
import { inboxItems, runIdOf } from '@/inbox'
import { useBox } from '@/use-box'
import { api as realApi, type Api, type Overview } from '@/wire/api'
import { useKehikot, type Host } from '@/wire/use-kehikot'

import { jumpFor, originOf, type GotoParams } from '../queue/origin.ts'
import { kindSaid } from '../queue/kinds.ts'
import { loadText } from '../queue/load.ts'
import type { RunView } from '../queue/queue.ts'
import type { LeaseView } from '../queue/leases.ts'
import { askedSaid, whoAsked } from '../queue/who.ts'
import { idleSaid } from '../queue/idle.ts'
import { KIND_WORDS, LIMITED } from '../queue/kinds.ts'

type Press = { item: string; value?: PressValue }

/** An Inbox item the person opened (`kehikot.opened`, protocol 2.35.0); `n` tells two opens of one item apart. */
export type OpenedItem = { item: string; n: number }

/** Where the settings are, when the host could not open them (one before protocol 2.90.0). */
export const SETTINGS_WHERE = 'Change it in Kehikot’s Settings › Modules › Queue.'

/** The page: the queue as last read, at the container's scope (protocol 2.29.0). */
export function App() {
  const press = useCallback(({ item, value }: Press) => pressed(item, value), [])
  const [openedItem, setOpenedItem] = useState<OpenedItem | null>(null)
  const onOpened = useCallback(({ item }: { item: string }) => setOpenedItem((was) => ({ item, n: (was?.n ?? 0) + 1 })), [])
  const host = useKehikot({ onPress: press, onOpened })
  const items = useMemo(() => headerItems(), [])
  const { header } = host
  useEffect(() => header(items), [header, items])
  return <Screen host={host} items={items} onPress={press} openedItem={openedItem} />
}

export function Screen({
  host,
  api = realApi,
  items = headerItems(),
  showing: asked,
  onPress = () => {},
  now = () => Date.now(),
  openedItem = null,
  box: given,
}: {
  host: Host
  api?: Api
  items?: HeaderItem[]
  showing?: Showing
  onPress?: (press: Press) => void
  now?: () => number
  /** The Inbox item the person last opened: its run is shown, scrolled to and opened. */
  openedItem?: OpenedItem | null
  /** The container's size, when the tests say it; else measured. */
  box?: Box
}) {
  const root = useRef<HTMLDivElement>(null)
  const measured = useBox(root)
  const level: Level = levelOf(given ?? measured)
  const server = useServerStanding()
  /* Every project's runs at This computer (the default), the open project's at Project: the scope, said by the host. */
  const showing: Showing = asked ?? showingOf(host.workingScope, host.projectPath)
  /* The queue is this computer's: it is drawn with no project open too. */
  const served = coverFor({ ...host, server }, { project: false })
  const [overview, setOverview] = useState<Overview | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  /* When the queue was last read, and whether the last read failed (issue #47): a queue out of reach is never drawn as zero. */
  const [seenAt, setSeenAt] = useState<number | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const lost = served === 'down' || readFailed
  /* The last numbers stay, greyed and with their age, instead of the server-down cover; with none to keep, the cover says it. */
  const cover = served === 'down' && overview !== null ? null : served
  /* The run whose output the drawer shows: one at a time, by id. */
  const [open, setOpen] = useState<string | null>(null)
  const [jumpSaid, setJumpSaid] = useState<string | null>(null)
  /* A chart pressed: the host opens Queue's settings at the setting it draws (`settings.open`, protocol 2.90.0). */
  const openSetting = useCallback(
    async (key: string) => {
      try {
        const got = settingsOpenResult.safeParse(await host.request('settings.open', { key }))
        if (got.success && got.data.outcome === 'opened') setJumpSaid(null)
        else setJumpSaid(got.success && got.data.why ? got.data.why : SETTINGS_WHERE)
      } catch {
        setJumpSaid(SETTINGS_WHERE)
      }
    },
    [host],
  )
  const partName = useCallback((id: string) => host.parts.find((part) => part.id === id)?.heading || id, [host.parts])
  const jump = (run: RunView) => <JumpButton run={run} host={host} partName={partName} onSaid={setJumpSaid} />

  const read = useCallback(() => {
    api.runs().then(
      (got) => {
        setOverview(got)
        setSaid(null)
        setReadFailed(false)
        setSeenAt(now())
      },
      (error: unknown) => {
        setReadFailed(true)
        setSaid(error instanceof Error ? error.message : String(error))
      },
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  /* Read when the server says the queue changed, never on a clock; the stream says so once as it
     opens, so this is also the first read, and again whenever the page is shown after being hidden. */
  useEffect(() => api.changes(read), [api, read])

  /* The Inbox: every run of the last day, filed under its own project, quietly: nothing needs the person. */
  const { activity } = host
  useEffect(() => {
    if (overview && host.where === 'hosted') activity(inboxItems(overview.runs, now()))
  }, [activity, overview, host.where, now])

  const act = (done: Promise<Overview>) =>
    done.then(
      (got) => {
        setOverview(got)
        setSaid(null)
        setReadFailed(false)
        setSeenAt(now())
      },
      (error: unknown) => setSaid(error instanceof Error ? error.message : String(error)),
    )

  const runs = useMemo(() => {
    const all = overview?.runs ?? []
    return showing === 'all' || !host.projectPath ? all : all.filter((run) => run.project === host.projectPath)
  }, [overview, showing, host.projectPath])

  /* The drawer's run is looked up by id in the whole queue, so it stays open while the list narrows or changes. */
  const opened = open ? overview?.runs.find((run) => run.id === open) : undefined

  /* The run of the Inbox item the person opened: highlighted, scrolled to, its output opened. Waits
     for the queue's first read; an item whose run has gone is ignored. Each open is handled once. */
  const [focused, setFocused] = useState<string | null>(null)
  const handled = useRef(0)
  useEffect(() => {
    if (!openedItem || !overview || handled.current === openedItem.n) return
    handled.current = openedItem.n
    const id = runIdOf(openedItem.item)
    if (!id || !overview.runs.some((run) => run.id === id)) return
    setFocused(id)
    setOpen(id)
  }, [openedItem, overview])
  useEffect(() => {
    if (!focused) return
    const row = [...document.querySelectorAll<HTMLElement>('li[data-run]')].find((one) => one.dataset.run === focused)
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }, [focused])

  /* A narrow or short container: one line per run, which opens its drawer. Room for more: the row. */
  const row = (run: RunView, children?: React.ReactNode) =>
    level === 'list' ? (
      <RunLine key={run.id} run={run} focused={focused === run.id} onOpen={() => setOpen(run.id)} />
    ) : (
      <RunRow key={run.id} run={run} now={now()} jump={jump(run)} focused={focused === run.id} detailed={level === 'full'} onOutput={() => setOpen(run.id)}>
        {children}
      </RunRow>
    )
  /* The footer the host draws (2.38.0): the queue, the load and the latest results in words, and
     what went wrong, so a container folded to its header and footer still says them. An older host
     draws no footer, and the page keeps saying what went wrong itself. */
  const drawsFooter = host.where === 'hosted' && host.drawsFooter === true
  const footerSaid = drawsFooter && !cover ? JSON.stringify(footerItems(lost ? { runs: [], machine: null, trouble: unreachableSaid(seenAt, now()), leases: [] } : { runs, machine: overview?.machine ?? null, trouble: said, leases: overview?.leases ?? [] })) : null
  const { footer } = host
  useEffect(() => {
    if (footerSaid) footer?.(JSON.parse(footerSaid))
  }, [footer, footerSaid])

  /* The host's cover stays up until the page is drawn (protocol 2.70.0): said once the queue's first
     read is drawn, what went wrong reading it, or the page's own cover for a server that is down or
     stale. Never gated on `visible`: a page the host keeps hidden still says it is ready, or its
     cover would wait out the hold. */
  const drawn = overview !== null || said !== null || cover === 'down' || cover === 'stale'
  const { ready } = host
  useEffect(() => {
    if (drawn) ready?.()
  }, [ready, drawn])

  const waiting = runs.filter((run) => run.state === 'queued')
  const running = runs.filter((run) => run.state === 'running')
  const finished = runs.filter((run) => run.state !== 'queued' && run.state !== 'running')
  const leased = (overview?.leases ?? []).filter((lease) => lease.state === 'running')

  return (
    <div data-kehikot-page ref={root} className="flex h-screen min-w-0 flex-col text-sm" data-level={level}>
      {host.where === 'unhosted' ? (
        <header className="flex min-h-9 shrink-0 items-center gap-2 border-b px-2">
          <span className="text-xs font-medium">Queue</span>
          <HeaderMenus items={items} onPress={onPress} />
        </header>
      ) : null}
      <main data-kehikot-scroll className={`flex min-h-0 flex-1 flex-col overflow-auto ${level === 'glance' || level === 'list' ? 'gap-2 p-2' : 'gap-3 p-3'}`}>
        {cover ? (
          <Cover state={cover} name="Queue" onRetry={read} detail={cover === 'down' ? unreachableSaid(seenAt, now()) : null} />
        ) : (
          <>
            {lost ? (
              <p className="text-destructive text-xs" role="alert" data-testid="unreachable">
                {unreachableSaid(seenAt, now())}
                {overview ? ' The numbers below are the last known ones.' : ''}
              </p>
            ) : null}
            <div className={`flex min-h-0 flex-col ${level === 'glance' || level === 'list' ? 'gap-2' : 'gap-3'} ${lost ? 'opacity-50 grayscale' : ''}`} data-stale={lost ? 'true' : undefined} data-testid="numbers">
            {overview ? <Glance runs={runs} machine={overview.machine} now={now()} onOpen={(key) => void openSetting(key)} width={given ? given.width - (level === 'glance' || level === 'list' ? 16 : 24) : undefined} /> : null}
            {overview && level === 'full' ? <MachineLine overview={overview} /> : null}
            {jumpSaid ? (
              <p className="text-muted-foreground text-xs" role="status" data-testid="jump-said">
                {jumpSaid}
              </p>
            ) : null}
            {said && !drawsFooter && !lost ? (
              <p className="text-destructive text-xs" role="alert" data-testid="said">
                {said}
              </p>
            ) : null}
            {overview && !runs.length && atLeast(level, 'list') ? (
              <p className="text-muted-foreground text-xs" data-testid="empty">
                {showing === 'here' && host.projectPath ? 'Nothing queued for this project lately. Every project’s: pick This computer as the scope in its settings.' : 'Nothing queued lately.'}
              </p>
            ) : null}
            {atLeast(level, 'list') ? (
            <>
            <Group title="Waiting" runs={waiting} compact={level === 'list'}>
              {(run, at) =>
                row(
                  run,
                  level === 'list' ? null : <>
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
                  </>,
                )
              }
            </Group>
            <Group title="Running" runs={running} compact={level === 'list'}>
              {(run) => row(run, <Cancel run={run} onCancel={() => void act(api.cancel(run.id))} />)}
            </Group>
            <Leases leases={leased} most={overview?.machine.leasesMost ?? null} compact={level === 'list'} onStop={(id) => void act(api.release(id))} />
            <Group title="Finished" runs={finished} compact={level === 'list'}>
              {(run) => row(run)}
            </Group>
            </>
            ) : null}
            </div>
          </>
        )}
      </main>
      <Sheet open={opened !== undefined} onOpenChange={(next) => (next ? undefined : setOpen(null))}>
        {opened ? <RunDrawer run={opened} api={api} jump={jump(opened)} jumpSaid={jumpSaid} onCancel={() => void act(api.cancel(opened.id))} /> : null}
      </Sheet>
    </div>
  )
}

function MachineLine({ overview }: { overview: Overview }) {
  const { machine } = overview
  return (
    <p className="text-muted-foreground text-xs" data-testid="machine">
      {machine.cores} cores · load {loadText(machine.load)} · at most {machine.most} at once{perKindSaid(machine.perKind)} · nothing new above load {loadText(machine.loadAbove)}, except after {machine.waitMinutes} min waiting · change in Kehikot’s Settings › Modules
    </p>
  )
}

/** The per-kind limits, short: " (1 typecheck, 1 e2e tests, 2 tests, 1 build, 2 task)". Empty from an older server. */
export function perKindSaid(perKind: Partial<Record<string, number>> | undefined): string {
  const said = LIMITED.filter((kind) => (perKind?.[kind] ?? 0) > 0).map((kind) => `${perKind![kind]} ${KIND_WORDS[kind]}`)
  return said.length ? ` (${said.join(', ')})` : ''
}

/**
 * The leased dev servers: what runs, on which port, who leased it and until when, and Stop. The port
 * is said as text: a module's strings are never links.
 */
function Leases({ leases, most, compact, onStop }: { leases: LeaseView[]; most: number | null; compact: boolean; onStop: (id: string) => void }) {
  if (!leases.length) return null
  return (
    <section aria-label="Dev servers" className={`flex flex-col ${compact ? 'gap-0.5' : 'gap-1'}`} data-testid="leases">
      <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        Dev servers ({leases.length}{most !== null ? ` of ${most}` : ''})
      </h2>
      <ul className={`flex flex-col ${compact ? 'gap-0' : 'gap-1'}`}>
        {leases.map((lease) => (
          <li key={lease.id} className={compact ? 'flex min-w-0 items-center gap-1.5 px-1 text-xs' : 'rounded-md border px-2 py-1.5'} data-lease={lease.id}>
            <div className="flex min-w-0 items-center gap-2">
              <LoaderCircle className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium" title={lease.argv.join(' ')}>
                {lease.label}
              </span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">:{lease.port}</span>
              <Button variant="ghost" size="sm" className="size-6 p-0" aria-label={`Stop the dev server “${lease.label}”`} onClick={() => onStop(lease.id)}>
                <X className="size-3" />
              </Button>
            </div>
            {compact ? null : (
              <p className="text-muted-foreground mt-0.5 text-xs break-words">
                localhost:{lease.port} · leased by {whoAsked(lease.asker)} · until {short(lease.until)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Group({ title, runs, compact = false, children }: { title: string; runs: RunView[]; compact?: boolean; children: (run: RunView, at: number) => React.ReactNode }) {
  if (!runs.length) return null
  return (
    <section aria-label={title} className={`flex flex-col ${compact ? 'gap-0.5' : 'gap-1'}`}>
      <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {title} ({runs.length})
      </h2>
      <ul className={`flex flex-col ${compact ? 'gap-0' : 'gap-1'}`}>{runs.map((run, at) => children(run, at))}</ul>
    </section>
  )
}

const STATE_WORDS: Record<RunView['state'], string> = { queued: 'Waiting', running: 'Running', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled' }

function StateMark({ run, iconOnly = false }: { run: RunView; iconOnly?: boolean }) {
  const Icon = run.state === 'passed' ? CircleCheck : run.state === 'failed' ? CircleX : run.state === 'cancelled' ? CircleSlash : run.state === 'running' ? LoaderCircle : CircleDashed
  const tone = run.state === 'passed' ? 'text-emerald-600 dark:text-emerald-400' : run.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 text-xs font-medium ${tone}`} data-state={run.state}>
      <Icon className={`size-3.5 ${run.state === 'running' ? 'animate-spin' : ''}`} aria-hidden />
      {iconOnly ? null : STATE_WORDS[run.state]}
      {!iconOnly && run.exit !== null && run.state !== 'passed' ? ` (exit ${run.exit})` : ''}
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
 * One run in a narrow or short container: its state (an icon with its word for a screen reader), its
 * label and when, on one line. Pressing it opens the drawer, which has everything else.
 */
function RunLine({ run, focused, onOpen }: { run: RunView; focused: boolean; onOpen: () => void }) {
  const when = run.state === 'queued' ? run.position !== null ? `#${run.position}` : '' : run.state === 'running' ? (run.startedAt !== null ? `since ${short(run.startedAt)}` : '') : run.finishedAt !== null ? short(run.finishedAt) : ''
  return (
    <li data-run={run.id} data-focused={focused ? 'true' : undefined}>
      <button
        type="button"
        className={`hover:bg-accent focus-visible:ring-ring flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs outline-none focus-visible:ring-2 ${focused ? 'bg-accent' : ''}`}
        aria-haspopup="dialog"
        aria-label={`“${run.label}”: ${STATE_WORDS[run.state]}${run.exit !== null && run.state !== 'passed' ? ` (exit ${run.exit})` : ''}. Details and output`}
        onClick={onOpen}
      >
        <StateMark run={run} iconOnly />
        {/* A label is the asker's words: text, never markup. */}
        <span className="min-w-0 flex-1 truncate" title={run.state === 'queued' && run.waiting ? run.waiting : undefined}>
          {run.label}
          {run.state === 'running' && run.idleSince != null ? <span className="text-amber-700 dark:text-amber-400" data-testid="idle-line"> · idle in its slot</span> : null}
          {run.state === 'queued' ? <span className="text-muted-foreground"> · {whoAsked(run.asker)}</span> : null}
        </span>
        <span className="text-muted-foreground shrink-0 tabular-nums">{when}</span>
      </button>
    </li>
  )
}

/**
 * One run: what it is, its kind, the jump into where it came from, its buttons and its output. With
 * room (`detailed`), where it came from, how long it waited and ran, and why it ended. A run still
 * waiting or running says since when rather than for how long: the page is redrawn when the queue
 * changes, not on a clock, and a duration would stand still between changes.
 */
function RunRow({
  run,
  now,
  jump,
  focused = false,
  detailed = true,
  onOutput,
  children,
}: {
  run: RunView
  now: number
  jump: React.ReactNode
  focused?: boolean
  detailed?: boolean
  onOutput: () => void
  children?: React.ReactNode
}) {
  const waited = run.state === 'queued' ? `waiting since ${clock(run.queuedAt)}` : `waited ${seconds((run.startedAt ?? run.finishedAt ?? now) - run.queuedAt)}`
  const ran = run.startedAt === null ? null : run.finishedAt === null ? `running since ${clock(run.startedAt)}` : `ran ${seconds(run.finishedAt - run.startedAt)}`
  const expected = run.expect === 'fail' ? (run.state === 'failed' ? 'failed as expected' : 'expected to fail') : null
  return (
    <li className={`rounded-md border px-2 py-1.5 ${focused ? 'bg-accent' : ''}`} data-run={run.id} data-focused={focused ? 'true' : undefined}>
      <div className="flex min-w-0 items-center gap-2">
        <StateMark run={run} />
        {/* A label is the asker's words: text, never markup. */}
        <span className="min-w-0 flex-1 truncate font-medium" title={run.argv.join(' ')}>
          {run.label}
        </span>
        <Badge variant="outline">{kindSaid(run.kind)}</Badge>
        {jump}
        {children}
      </div>
      {detailed ? (
        <p className="text-muted-foreground mt-0.5 text-xs break-words">
          {run.state === 'queued' && run.waiting ? `${run.waiting} ` : ''}
          From {askedSaid(run.asker)}
          {run.epic ? ` · epic ${run.epic}` : ''}
          {run.refs.length ? ` · for ${run.refs.join(', ')}` : ''} · {waited}
          {ran !== null ? ` · ${ran}` : ''}
          {run.why ? ` · ${run.why}` : ''}
          {expected ? ` · ${expected}` : ''}
        </p>
      ) : (
        <p className="text-muted-foreground mt-0.5 truncate text-xs">
          {run.state === 'queued' && run.waiting ? `${run.waiting} · ${whoAsked(run.asker)}` : ran ?? waited}
          {expected ? ` · ${expected}` : ''}
        </p>
      )}
      {run.state === 'running' && run.idleSince != null ? (
        <p className="text-amber-700 dark:text-amber-400 mt-0.5 text-xs break-words" data-testid="idle">
          {idleSaid(run.idleSince, now)}
        </p>
      ) : null}
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
const short = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** One run in the drawer: what it is, when, where from, and its output. One at a time. */
function RunDrawer({ run, api, jump, jumpSaid, onCancel }: { run: RunView; api: Api; jump: React.ReactNode; jumpSaid: string | null; onCancel: () => void }) {
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
            <Badge variant="outline">{kindSaid(run.kind)}</Badge>
            {jump}
            {run.state === 'queued' || run.state === 'running' ? <Cancel run={run} onCancel={onCancel} /> : null}
          </div>
          <p data-testid="drawer-times">
            Asked {clock(run.queuedAt)} · started {clock(run.startedAt)} · {run.finishedAt === null ? 'not finished' : `finished ${clock(run.finishedAt)}`}
            {ran !== null ? ` · ran ${seconds(ran)}` : ''}
          </p>
          <p className="break-words" data-testid="drawer-origin">
            {run.state === 'queued' && run.position !== null ? `#${run.position} in line · ` : ''}
            From {askedSaid(run.asker)}
            {origin?.epic ? ` · epic ${origin.epic}` : ''}
            {origin?.branch ? ` · branch ${origin.branch}` : ''}
          </p>
          {run.why ? <p>{run.why}</p> : null}
          {run.state === 'running' && run.idleSince != null ? <p data-testid="drawer-idle">{idleSaid(run.idleSince, Date.now())}</p> : null}
          {run.expect === 'fail' ? <p>{run.state === 'failed' ? 'It failed, as expected.' : run.state === 'passed' ? 'It passed, but it was expected to fail.' : 'It is expected to fail.'}</p> : null}
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
