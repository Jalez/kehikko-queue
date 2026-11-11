import { useRef } from 'react'
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, XAxis, YAxis } from 'recharts'

import { Plot } from '@/components/plot'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { clock, HEAD_HEIGHT, holding, loadTip, niceTop, PAD_X, PAD_Y, queueNow, queueOver, queueSaid, queueTip, ROW_GAP, strainSaid, SUB_HEIGHT, tileLayout, type TileLayout } from '@/glance'
import { useBox } from '@/use-box'
import type { Machine } from '@/wire/api'

import type { RunView } from '../../queue/queue.ts'

/**
 * The two tiles a person reads at a glance: the waiting (how many runs are in line, over the last half
 * hour, with the running as a second, labelled line) and the strain (the machine's load against the limit
 * above which new runs wait). The latest results are not a tile: the list and the footer say them. Each says its numbers in words, and each chart is an image with its sentence: a chart is
 * never the only place a number is. Stacked as rows in a narrow container, side by side from 360 px.
 * The tiles have no cards: a hairline between them, tight padding, the plot edge to edge. In one
 * column a tile's title, words and number are one row with the plot directly under it (`tileLayout`):
 * a sparkline under 260 px, axes and gridlines from there. Pointing at a chart, touching it or
 * arrowing through it from the keyboard shows a small solid tooltip outside the plot (`Plot`).
 * Colours are the page's tokens (`--chart-*`), in both themes; 
 */

const QUEUE: ChartConfig = { waiting: { label: 'Waiting', color: 'var(--chart-queue)' }, running: { label: 'Running', color: 'var(--chart-pass)' } }
const LOAD: ChartConfig = { load: { label: 'Load', color: 'var(--chart-load)' } }
const MARGIN = { top: 2, right: 0, bottom: 0, left: 0 }
/* Room for the top tick's text above the plot and the last time's below it, so no axis is clipped. */
const AXES_MARGIN = { top: 6, right: 4, bottom: 0, left: 0 }

/** `width`: the tiles' row, when the tests say it; else measured. */
export function Glance({ runs, machine, now, width }: { runs: readonly RunView[]; machine: Machine; now: number; width?: number }) {
  const row = useRef<HTMLDivElement>(null)
  const measured = useBox(row)
  const layout = tileLayout(width ?? measured?.width ?? null)
  const queue = queueNow(runs, machine)
  const over = queueOver(runs, now)
  const samples = machine.samples ?? []
  const held = holding(machine)
  const top = niceTop(Math.max(1, ...over.map((one) => Math.max(one.waiting, one.running))))
  return (
    /* No cards: the grid's 1 px gap shows the border colour between tiles, which stand on the page's own background. */
    <div ref={row} className="bg-border grid min-w-0 shrink-0 grid-cols-1 gap-px @min-[360px]:grid-cols-2" data-testid="glance" data-axes={layout.axes} data-compact={layout.compact}>
      <Tile layout={layout} title="Waiting" label="Runs waiting in the queue" value={queue.waiting ? `${queue.waiting} waiting` : 'none waiting'} sub={`${queue.running}/${queue.most} running`} testId="tile-queue">
        <Plot said={queueSaid(queue)} count={over.length} kind="line" height={layout.plot} tip={(i) => queueTip(over[i]!, queue.most)} testId="tile-queue">
          {(active) => (
            <AreaPlot data={over} dataKey="waiting" also="running" config={QUEUE} axes={layout.axes} active={active} top={top} limit={null} step format={(v) => String(v)} />
          )}
        </Plot>
      </Tile>
      <Tile
        layout={layout}
        title="Load"
        value={`${machine.load.toFixed(1)} / ${machine.loadAbove.toFixed(1)}`}
        sub={held ? 'holding new runs' : `${machine.cores} cores`}
        subTone={held ? 'text-destructive' : undefined}
        testId="tile-load"
      >
        <Plot said={strainSaid(machine, samples)} count={samples.length > 1 ? samples.length : 0} kind="line" height={layout.plot} tip={(i) => loadTip(samples[i]!, machine)} testId="tile-load">
          {(active) =>
            samples.length > 1 ? (
              <AreaPlot
                data={samples}
                dataKey="load"
                config={LOAD}
                axes={layout.axes}
                active={active}
                top={niceTop(Math.max(machine.loadAbove, ...samples.map((one) => one.load)) * 1.1)}
                limit={machine.loadAbove}
                format={(v) => String(v)}
              />
            ) : null
          }
        </Plot>
      </Tile>
    </div>
  )
}

/** The first time anchored at its start and the last at its end, so neither runs off the plot. */
function EdgeTick({ x, y, payload, index }: { x?: number | string; y?: number | string; payload?: { value: number }; index?: number }) {
  return (
    <text x={x} y={y} dy={10} textAnchor={index === 0 ? 'start' : 'end'} fontSize={10} fill="var(--muted-foreground)">
      {clock(Number(payload?.value ?? 0))}
    </text>
  )
}

function AreaPlot<T extends { at: number }>({
  data,
  dataKey,
  also,
  config,
  axes,
  active,
  top,
  limit,
  step = false,
  format,
}: {
  data: readonly T[]
  dataKey: keyof T & string
  /** A second series drawn as a line over the first, labelled in the config. */
  also?: keyof T & string
  config: ChartConfig
  axes: boolean
  active: number | null
  top: number
  /** The dashed line the value is held against: the load above which runs wait; none for the queue. */
  limit: number | null
  step?: boolean
  format: (value: number) => string
}) {
  const first = data[0]?.at ?? 0
  const last = data.at(-1)?.at ?? 0
  const on = active === null ? null : data[active]
  return (
    <ChartContainer config={config} className="aspect-auto size-full">
      <AreaChart data={data as T[]} margin={axes ? AXES_MARGIN : MARGIN} accessibilityLayer={false}>
        {axes ? <CartesianGrid vertical={false} stroke="var(--border)" /> : null}
        <YAxis hide={!axes} width={axes ? 32 : 0} domain={[0, top]} ticks={[0, top]} tickFormatter={format} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval={0} allowDecimals={false} />
        <XAxis hide={!axes} dataKey="at" type="number" domain={[first, last]} ticks={[first, last]} interval={0} tickLine={false} axisLine={false} height={16} tick={<EdgeTick />} />
        {limit === null ? null : <ReferenceLine y={limit} stroke="var(--muted-foreground)" strokeDasharray="3 3" ifOverflow="extendDomain" />}
        {on ? <ReferenceLine x={on.at} stroke="var(--muted-foreground)" strokeDasharray="2 2" /> : null}
        <Area dataKey={String(dataKey)} type={step ? 'stepAfter' : 'monotone'} stroke={`var(--color-${dataKey})`} fill={`var(--color-${dataKey})`} fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
        {also ? <Area dataKey={String(also)} type={step ? 'stepAfter' : 'monotone'} stroke={`var(--color-${also})`} fill="none" strokeWidth={1.5} strokeDasharray="4 2" isAnimationActive={false} /> : null}
        {on ? <ReferenceDot x={on.at} y={Number(on[dataKey])} r={3} fill={`var(--color-${dataKey})`} stroke="var(--background)" /> : null}
      </AreaChart>
    </ChartContainer>
  )
}

/**
 * A glance tile, with no card of its own: tight padding, the page's background, a hairline between
 * it and the next (the grid's gap). In one column (`compact`) its title, line in words and number are
 * one row, the plot directly under it; side by side the words go on a line under the title. Nothing
 * overlays the plot but the tooltip, which sits outside it.
 */
function Tile({ layout, title, label, value, sub, subTone, testId, children }: { layout: TileLayout; title: string; /** What a screen reader calls the tile, when its title alone would be taken for the list's section of the same name. */ label?: string; value: string; sub: string; subTone?: string; testId: string; children: React.ReactNode }) {
  const words = (
    <p className={`min-w-0 truncate text-[11px] ${subTone ?? 'text-muted-foreground'} ${layout.compact ? 'flex-1' : ''}`} style={{ lineHeight: `${layout.compact ? HEAD_HEIGHT : SUB_HEIGHT}px` }} title={sub}>
      {sub}
    </p>
  )
  return (
    <section aria-label={label ?? title} className="bg-background flex min-w-0 flex-col" style={{ padding: `${PAD_Y}px ${PAD_X}px`, rowGap: ROW_GAP }} data-testid={testId}>
      <div className="flex min-w-0 items-baseline justify-between gap-2" style={{ height: HEAD_HEIGHT, lineHeight: `${HEAD_HEIGHT}px` }} data-testid={`${testId}-head`}>
        <h2 className="text-muted-foreground shrink-0 text-[10px] font-medium tracking-wide uppercase">{title}</h2>
        {layout.compact ? words : null}
        <p className="min-w-0 truncate text-sm font-semibold tabular-nums" data-testid={`${testId}-value`} title={value}>
          {value}
        </p>
      </div>
      {layout.compact ? null : words}
      {children}
    </section>
  )
}
