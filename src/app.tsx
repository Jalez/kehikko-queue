import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { pickedParts, type HeaderItem, type PressValue } from 'kehikot-module-protocol'
import { Cover, coverFor, useFocus, useServerStanding } from 'kehikot-module-protocol/client/react'

import { HeaderMenus } from '@/components/header-menus'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { headerItems, pressed, type Showing } from '@/header'
import { inboxItems } from '@/inbox'
import { api as realApi, type Api } from '@/wire/api'
import { useKehikot, type Host } from '@/wire/use-kehikot'

import type { Edit, Note } from '../store.ts'

type Press = { item: string; value?: PressValue }

/**
 * The page. It owns every bit of its state: the view the header switch is on,
 * and the notes as last read. The host draws the header from what is declared
 * here, and is told the whole list again whenever it changes.
 */
export function App() {
  const [showing, setShowing] = useState<Showing>('open')
  /* One handler for a press from the host's menus and from this page's own copy of them. A sentence is "not taken, and why". */
  const press = useCallback(({ item, value }: Press) => {
    const view = pressed(item, value)
    if (view !== 'open' && view !== 'all') return view
    setShowing(view)
  }, [])
  const host = useKehikot({ onPress: press })
  const items = useMemo(() => headerItems(showing), [showing])
  /* Declared at mount and again whenever it changes; the client replays it on every greeting. */
  const { header } = host
  useEffect(() => header(items), [header, items])
  return <Screen host={host} items={items} showing={showing} onPress={press} />
}

/**
 * Everything drawn, from a plain `Host`, so a test draws it with a made-up
 * context (test/render.test.tsx).
 */
export function Screen({
  host,
  api = realApi,
  items = headerItems('open'),
  showing = 'open',
  onPress = () => {},
}: {
  host: Host
  api?: Api
  items?: HeaderItem[]
  showing?: Showing
  onPress?: (press: Press) => void
}) {
  /* What this page's own server last did, learned by every `ask()`: it stopped, or restarted under this page. */
  const server = useServerStanding()
  const [again, setAgain] = useState(0)
  /* The one screen for every not-ready moment: waiting for a host, no host, no project, a stopped server. */
  const cover = coverFor({ ...host, server }, { project: true })

  return (
    <div className="flex h-screen min-w-0 flex-col text-sm">
      {/* Hosted, the host draws the header items in the container's own header. Alone, the page does. */}
      {host.where === 'unhosted' ? (
        <header className="flex min-h-9 shrink-0 items-center gap-2 border-b px-2">
          <span className="text-xs font-medium">Example</span>
          <HeaderMenus items={items} onPress={onPress} />
        </header>
      ) : null}
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        {cover ? (
          <Cover state={cover} name="Example" onRetry={() => setAgain((n) => n + 1)} />
        ) : (
          <>
            <Where host={host} />
            <Notes key={`${host.projectPath}:${again}`} host={host} api={api} showing={showing} />
          </>
        )}
      </main>
    </div>
  )
}

/** Where the host says the person is: project, epic and the parts picked out. */
function Where({ host }: { host: Host }) {
  return (
    <p className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1 text-xs" data-testid="where">
      <span className="truncate" data-testid="project">{host.project ?? 'No project'}</span>
      <span aria-hidden>›</span>
      <span className="truncate" data-testid="epic">{host.epic ?? 'no epic open'}</span>
      {/* Said even when nothing is picked: "the whole epic" is an answer, and a blank would read as a host that did not say. */}
      {host.epic ? (
        <Badge variant="outline" data-testid="parts">
          {host.picked.length ? host.picked.join(', ') : 'the whole epic'}
        </Badge>
      ) : null}
    </p>
  )
}

/** The notes of this project, narrowed to the epic and to the parts picked, with a line to add one. */
function Notes({ host, api, showing }: { host: Host; api: Api; showing: Showing }) {
  const projectPath = host.projectPath!
  const [notes, setNotes] = useState<Note[] | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const focus = useFocus(host)

  useEffect(() => {
    let live = true
    api
      .read(projectPath)
      .then((read) => live && setNotes(read))
      .catch((error: unknown) => live && setSaid(error instanceof Error ? error.message : String(error)))
    return () => {
      live = false
    }
  }, [projectPath, api])

  /* The Inbox gets every open note of this epic, whole, whenever the list changes. */
  const { activity, epic } = host
  useEffect(() => {
    if (notes) activity(inboxItems(notes, epic))
  }, [activity, notes, epic])

  const edit = (one: Edit) =>
    api
      .edit(projectPath, one)
      .then((next) => {
        setNotes(next)
        setSaid(null)
        return true
      })
      .catch((error: unknown) => {
        setSaid(error instanceof Error ? error.message : String(error))
        return false
      })

  if (notes === null) return said ? <p className="text-destructive text-xs">{said}</p> : null

  /* The epic's notes, then THE rule for parts: a note is anchored to the parts it was written under. */
  const ofEpic = notes.filter((note) => note.epic === host.epic && (showing === 'all' || !note.done))
  const { shown, empty } = focus.narrow(ofEpic, (note) => (note.parts.length ? note.parts.map((part) => ({ part })) : { whole: true }), { noun: 'note' })

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          const parts = pickedParts(host.parts).map((part) => part.id)
          void edit({ op: 'add', text: draft, epic: host.epic, parts }).then((done) => done && setDraft(''))
        }}
      >
        <Input aria-label="A new note" placeholder="A note about this epic" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          Add
        </Button>
      </form>
      {said ? <p className="text-destructive text-xs" data-testid="said">{said}</p> : null}
      {empty ? <p className="text-muted-foreground text-xs">{empty}</p> : null}
      {!shown.length && !empty ? <p className="text-muted-foreground text-xs">{showing === 'open' ? 'No open notes.' : 'No notes yet.'}</p> : null}
      <ul className="flex flex-col gap-1">
        {shown.map((note) => (
          <li key={note.id} className="group flex min-w-0 items-center gap-2">
            <input
              type="checkbox"
              aria-label={note.done ? `Reopen “${note.text}”` : `Finish “${note.text}”`}
              checked={note.done}
              onChange={(event) => void edit({ op: 'done', id: note.id, done: event.target.checked })}
            />
            {/* A note is the person's text: drawn as text, never as markup. */}
            <span className={`min-w-0 flex-1 break-words ${note.done ? 'text-muted-foreground line-through' : ''}`}>{note.text}</span>
            <Button variant="ghost" size="sm" className="size-6 p-0 opacity-60 group-hover:opacity-100" aria-label={`Remove “${note.text}”`} onClick={() => void edit({ op: 'remove', id: note.id })}>
              <X className="size-3" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
