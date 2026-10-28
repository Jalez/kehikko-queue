import { ChevronDown, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import { HEADER_MENUS, HEADER_MENU_NAMES, type HeaderItem, type HeaderMenu, type PressValue } from 'kehikot-module-protocol'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheck,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * The header items this module declares (`host.header(items)`), drawn by the page itself for the
 * one case the host cannot: nobody is framing it. Hosted, the host draws the same items in the
 * container's View, Go and Run menus and this is not rendered. A copy of the host's
 * `canvas/HeaderMenus.tsx` in the shared menu grammar, so a page opened on its own port has the
 * same controls in the same places. `onPress` is the handler the host's presses reach too.
 */

const TITLES: Record<HeaderMenu, string> = { view: 'View', go: 'Go', run: 'Run' }

export function HeaderMenus({ items, onPress }: { items: HeaderItem[]; onPress(press: { item: string; value?: PressValue }): void }) {
  return (
    <>
      {HEADER_MENU_NAMES.map((menu) => {
        const mine = items.filter((item) => HEADER_MENUS[item.kind] === menu)
        return mine.length ? <Menu key={menu} menu={menu} items={mine} onPress={onPress} /> : null
      })}
    </>
  )
}

function Menu({ menu, items, onPress }: { menu: HeaderMenu; items: HeaderItem[]; onPress(press: { item: string; value?: PressValue }): void }) {
  /* A run that has to be confirmed is armed by the first press and done by the second. One at a time. */
  const [armed, setArmed] = useState<string | null>(null)
  const busy = items.some((item) => item.kind === 'run' && item.state === 'busy')
  const failed = items.some((item) => item.kind === 'run' && item.state === 'failed')
  /* Items naming the same group are drawn together, in the order the first of each group came. */
  const groups: { name: string | null; items: HeaderItem[] }[] = []
  for (const item of items) {
    const name = item.group ?? null
    const group = groups.find((one) => one.name === name)
    if (group) group.items.push(item)
    else groups.push({ name, items: [item] })
  }

  return (
    <DropdownMenu onOpenChange={(open) => !open && setArmed(null)}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" data-menu={menu}>
          {TITLES[menu]}
          {busy ? <LoaderCircle className="size-3 animate-spin" aria-label="running" /> : null}
          {failed && !busy ? <TriangleAlert className="text-destructive size-3" aria-label="failed" /> : null}
          <ChevronDown className="text-muted-foreground size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        {groups.map((group, index) => (
          <div key={group.name ?? ''} role="group" aria-label={group.name ?? undefined}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            {group.name ? <DropdownMenuLabel>{group.name}</DropdownMenuLabel> : null}
            {group.items.map((item) => (
              <Rows key={item.id} item={item} armed={armed === item.id} onArm={setArmed} onPress={onPress} />
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Rows({
  item,
  armed,
  onArm,
  onPress,
}: {
  item: HeaderItem
  armed: boolean
  onArm(id: string | null): void
  onPress(press: { item: string; value?: PressValue }): void
}) {
  const hint = item.shortcut ? <span className="text-muted-foreground ml-auto pl-4 text-[10px]">{item.shortcut}</span> : null

  if (item.kind === 'toggle') {
    return (
      <DropdownMenuItem role="menuitemcheckbox" aria-checked={item.checked} onSelect={() => onPress({ item: item.id, value: !item.checked })}>
        <DropdownMenuCheck checked={item.checked} />
        <span className="flex-1">{item.label}</span>
        {hint}
      </DropdownMenuItem>
    )
  }

  if (item.kind === 'run') {
    return (
      <DropdownMenuItem
        disabled={item.disabled !== null || item.state === 'busy'}
        title={item.disabled ?? undefined}
        variant={armed ? 'destructive' : 'default'}
        onSelect={(event) => {
          if (item.confirm && !armed) {
            /* Kept open: the second press is the answer to the question the row just became. */
            event.preventDefault()
            onArm(item.id)
            return
          }
          onArm(null)
          onPress({ item: item.id })
        }}
      >
        <span className="flex-1">{armed ? `${item.label}?` : item.label}</span>
        {item.result ? <span className="text-muted-foreground pl-4 text-[10px]">{item.result}</span> : null}
        {hint}
      </DropdownMenuItem>
    )
  }

  /* A switch and a go item are both a list of options under the item's own label; only a switch has one checked. */
  return (
    <>
      <DropdownMenuLabel>{item.label}</DropdownMenuLabel>
      {item.options.map((option) => (
        <DropdownMenuItem
          key={option.id}
          {...(item.kind === 'switch' ? { role: 'menuitemradio', 'aria-checked': option.id === item.value } : {})}
          onSelect={() => onPress({ item: item.id, value: option.id })}
        >
          {item.kind === 'switch' ? <DropdownMenuCheck checked={option.id === item.value} /> : null}
          <span className="flex-1">{option.label}</span>
        </DropdownMenuItem>
      ))}
    </>
  )
}
