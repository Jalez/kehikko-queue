import { useId, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

import { indexAt, stepped, tipAlign, type Tip } from '@/glance'

/**
 * One tile's plot: the chart, the point a person is on, and a small tooltip saying it. The same for a
 * mouse, a finger and the keyboard — Tab to the chart, then ← → (Home, End) move along it and Escape
 * closes the tooltip — so the tooltip is drawn here, not by Recharts, and the chart is handed the
 * point to mark (`children(active)`).
 *
 * The chart is an image of its sentence (`said`, what a screen reader reads first); the tooltip is a
 * polite live region beside it, so each point is read as the keyboard moves. It sits inside the tile,
 * on the side away from the edge, and never makes the page scroll sideways.
 */
export function Plot({ said, count, kind, height, tip, testId, children }: { said: string; count: number; kind: 'line' | 'bar'; height: number; tip: (index: number) => Tip; testId: string; children: (active: number | null) => ReactNode }) {
  const id = useId()
  const [active, setActive] = useState<number | null>(null)
  const shown = active !== null && active < count ? active : null

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    setActive(indexAt(event.clientX - box.left, box.width, count, kind))
  }
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = stepped(event.key, shown, count)
    if (next === undefined) return
    event.preventDefault()
    setActive(next)
  }

  const align = tipAlign(shown ?? 0, count)
  const place: CSSProperties = align === 'start' ? { left: 0, top: 0 } : align === 'end' ? { right: 0, top: 0 } : { left: '50%', top: 0, transform: 'translateX(-50%)' }
  const told = shown === null ? null : tip(shown)

  return (
    <div className="relative min-w-0" style={{ height }} data-testid={`${testId}-plot`} data-kind={kind}>
      <div
        role="img"
        aria-label={said}
        aria-describedby={told ? `${id}-tip` : undefined}
        tabIndex={count ? 0 : -1}
        className="focus-visible:ring-ring size-full touch-pan-y rounded-sm outline-none focus-visible:ring-2"
        onFocus={() => setActive((was) => was ?? count - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={key}
        onPointerDown={point}
        onPointerMove={point}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse' && document.activeElement !== event.currentTarget) setActive(null)
        }}
      >
        {children(shown)}
      </div>
      <div
        id={`${id}-tip`}
        role="status"
        aria-live="polite"
        data-testid={`${testId}-tip`}
        className={told ? 'bg-popover text-popover-foreground border-border pointer-events-none absolute z-10 w-max max-w-full rounded-md border px-1.5 py-0.5 text-[11px] leading-tight break-words shadow-md' : 'sr-only'}
        style={told ? place : undefined}
      >
        {told ? (
          <>
            <span className="flex items-baseline gap-1.5">
              <span className="min-w-0 font-semibold tabular-nums">{told.value}</span>
              {told.at ? <span className="text-muted-foreground shrink-0 tabular-nums">{told.at}</span> : null}
            </span>
            {told.detail ? <span className="text-muted-foreground block tabular-nums">{told.detail}</span> : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
