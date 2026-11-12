import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

import { fromKeyboard, hideTip, showTip, useTip } from '@/lib/one-tip'
import { indexAt, PAD_X, stepped, TIP_GAP, tipAlign, tipSide, type Tip } from '@/glance'

/**
 * One tile's plot: the chart, the point a person is on, and a small tooltip saying it. The same for a
 * mouse, a finger and the keyboard — Tab to the chart, then ← → (Home, End) move along it and Escape
 * closes the tooltip — so the tooltip is drawn here, not by Recharts, and the chart is handed the
 * point to mark (`children(active)`).
 *
 * The chart is an image of its sentence (`said`, what a screen reader reads first); the tooltip is a
 * polite live region beside it, so each point is read as the keyboard moves. The tooltip is solid
 * (the popover token, a strong border and a shadow), 12 px, three short lines at most (`Tip`), and
 * sits outside the plot — above it when there is room, else below — so it never lies over the chart's
 * labels. Along the plot it leans away from the edge and never makes the page scroll sideways.
 *
 * One tooltip on the page at a time (`useTip`): it goes when the pointer leaves the plot or the page,
 * and focus shows it only from the keyboard, so a click never leaves one pinned.
 *
 * The plot runs through the tile's padding, edge to edge.
 */
export function Plot({
  said,
  count,
  kind,
  height,
  tip,
  testId,
  hint,
  onOpen,
  children,
}: {
  said: string
  count: number
  kind: 'line' | 'bar'
  height: number
  tip: (index: number) => Tip
  testId: string
  /** What pressing the chart does, said as the tooltip's last line and in its label: "Change the load limit…". */
  hint?: string
  /** Pressing the chart (a click, a tap, Enter or Space on it) opens the setting it is about. */
  onOpen?: () => void
  children: (active: number | null) => ReactNode
}) {
  const id = useId()
  const box = useRef<HTMLDivElement>(null)
  const tipBox = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<number | null>(null)
  const [side, setSide] = useState<'above' | 'below'>('above')
  const { key: tipKey, mine } = useTip()
  const shown = mine && active !== null && active < count ? active : null

  useEffect(() => {
    if (!mine) setActive(null)
  }, [mine])

  useLayoutEffect(() => {
    if (shown === null || !box.current || !tipBox.current) return
    setSide(tipSide(box.current.getBoundingClientRect().top - clipTop(box.current), tipBox.current.offsetHeight))
  }, [shown])

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const at = indexAt(event.clientX - rect.left, rect.width, count, kind)
    setActive(at)
    if (at === null) hideTip(tipKey)
    else showTip(tipKey, event.currentTarget, { touch: event.pointerType === 'touch' })
  }
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (onOpen && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      hideTip(tipKey)
      onOpen()
      return
    }
    const next = stepped(event.key, shown, count)
    if (next === undefined) return
    event.preventDefault()
    setActive(next)
    if (next === null) hideTip(tipKey)
    else showTip(tipKey, event.currentTarget, { keyboard: true })
  }

  const align = tipAlign(shown ?? 0, count)
  const across: CSSProperties = align === 'start' ? { left: TIP_GAP } : align === 'end' ? { right: TIP_GAP } : { left: '50%', transform: 'translateX(-50%)' }
  const place: CSSProperties = { ...across, ...(side === 'above' ? { bottom: `calc(100% + ${TIP_GAP}px)` } : { top: `calc(100% + ${TIP_GAP}px)` }) }
  const told = shown === null ? null : tip(shown)

  return (
    <div ref={box} className="relative min-w-0" style={{ height, marginInline: -PAD_X }} data-testid={`${testId}-plot`} data-kind={kind}>
      <div
        role="img"
        aria-label={hint ? `${said} ${hint}` : said}
        title={hint && !count ? hint : undefined}
        data-opens={onOpen ? '' : undefined}
        aria-describedby={told ? `${id}-tip` : undefined}
        tabIndex={count || onOpen ? 0 : -1}
        className={`focus-visible:ring-ring size-full touch-pan-y rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset ${onOpen ? 'cursor-pointer' : ''}`}
        onClick={
          onOpen
            ? () => {
                hideTip(tipKey)
                onOpen()
              }
            : undefined
        }
        onFocus={(event) => {
          if (!count || !fromKeyboard()) return
          setActive((was) => was ?? count - 1)
          showTip(tipKey, event.currentTarget, { keyboard: true })
        }}
        onBlur={() => {
          setActive(null)
          hideTip(tipKey)
        }}
        onKeyDown={key}
        onPointerDown={point}
        onPointerMove={point}
        onPointerLeave={(event) => {
          if (event.pointerType !== 'touch') hideTip(tipKey)
        }}
        onPointerCancel={() => hideTip(tipKey)}
      >
        {children(shown)}
      </div>
      <div
        ref={tipBox}
        id={`${id}-tip`}
        role="status"
        aria-live="polite"
        data-testid={`${testId}-tip`}
        data-side={told ? side : undefined}
        className={
          told
            ? 'bg-popover text-popover-foreground border-foreground/25 pointer-events-none absolute z-20 w-max max-w-[min(15rem,calc(100%-8px))] rounded-md border px-2 py-1.5 text-xs leading-snug break-words shadow-lg'
            : 'sr-only'
        }
        style={told ? place : undefined}
      >
        {told ? (
          <>
            <span className="block font-semibold tabular-nums">{told.value}</span>
            {told.detail ? <span className="block">{told.detail}</span> : null}
            {told.note ? <span className="text-muted-foreground block tabular-nums">{told.note}</span> : null}
            {hint ? (
              <span className="text-muted-foreground mt-0.5 block border-t pt-0.5" data-testid={`${testId}-hint`}>
                {hint}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

/** The top of what clips the plot (its nearest scrolling or clipping ancestor), else of the window, in px. */
function clipTop(from: HTMLElement): number {
  for (let at = from.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at)
    if (overflowY !== 'visible') return at.getBoundingClientRect().top
  }
  return 0
}
