import { useRef } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceDot, ReferenceLine, XAxis, YAxis } from 'recharts'

import { Plot } from '@/components/plot'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { clock, counts, holding, loadTip, niceTop, queueNow, queueSaid, queueTip, recentResults, resultsSaid, resultTip, runningOver, strainSaid, tileLayout, type Result } from '@/glance'
import { useBox } from '@/use-box'
import type { Machine } from '@/wire/api'

import type { RunView } from '../../queue/queue.ts'

/**
 * The three tiles a person reads at a glance: the queue (running of the most at once, and waiting),
 * the strain (the machine's load against the limit above which new runs wait), and the latest
 * results. Each says its numbers in words, and each chart is an image with its sentence: a chart is
 * never the only place a number is. Stacked as rows in a narrow container, side by side from 360 px.
 * A tile is its title and number in one row, a line in words, then the plot at a height of its own
 * (`tileLayout`): a sparkline under 260 px, axes and gridlines from there. Pointing at a chart,
 * touching it or arrowing through it from the keyboard shows a small tooltip (`Plot`).
 * Colours are the page's tokens (`--chart-*`), in both themes; a result's colour always has its word.
 */

const QUEUE: ChartConfig = { running: { label: 'Running', color: 'var(--chart-queue)' } }
const LOAD: ChartConfig = { load: { label: 'Load', color: 'var(--chart-load)' } }
const RESULTS: ChartConfig = { seconds: { label: 'Ran (s)', color: 'var(--chart-pass)' } }

const FILL: Record<Result['state'], string> = { passed: 'var(--chart-pass)', failed: 'var(--destructive)', cancelled: 'var(--muted-foreground)' }

const MARGIN = { top: 2, right: 0, bottom: 0, left: 0 }
/* Room for the top tick's text above the plot and the last time's below it, so no axis is clipped. */
const AXES_MARGIN = { top: 6, right: 2, bottom: 0, left: 0 }

/** `width`: the tiles' row, when the tests say it; else measured. */
export function Glance({ runs, machine, now, width }: { runs: readonly RunView[]; machine: Machine; now: number; width?: number }) {
  const row = useRef<HTMLDivElement>(null)
  const measured = useBox(row)
  const layout = tileLayout(width ?? measured?.width ?? null)
  const queue = queueNow(runs, machine)
  const over = runningOver(runs, now)
  const samples = machine.samples ?? []
  const results = recentResults(runs)
  const n = counts(results)
  const held = holding(machine)
  const most = Math.max(queue.most, 1)
  return (
    <div ref={row} className="grid min-w-0 shrink-0 grid-cols-1 gap-2 @min-[360px]:grid-cols-3" data-testid="glance" data-axes={layout.axes}>
      <Tile title="Queue" value={`${queue.running}/${queue.most} running`} sub={queue.waiting ? `${queue.waiting} waiting` : 'none waiting'} testId="tile-queue">
        <Plot said={queueSaid(queue)} count={over.length} kind="line" height={layout.plot} tip={(i) => queueTip(over[i]!, queue.most)} testId="tile-queue">
          {(active) => (
            <AreaPlot data={over} dataKey="running" config={QUEUE} axes={layout.axes} active={active} top={most} limit={queue.most} step format={(v) => String(v)} />
          )}
        </Plot>
      </Tile>
      <Tile
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
      <Tile
        title="Results"
        value={results.length ? `${n.passed} passed` : 'none yet'}
        sub={results.length ? `${n.failed} failed${n.cancelled ? ` · ${n.cancelled} cancelled` : ''}` : 'no run has ended'}
        subTone={n.failed ? 'text-destructive' : undefined}
        testId="tile-results"
      >
        <Plot said={resultsSaid(results)} count={results.length} kind="bar" height={layout.plot} tip={(i) => resultTip(results[i]!)} testId="tile-results">
          {(active) => (results.length ? <ResultBars results={results} axes={layout.axes} active={active} /> : null)}
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
  config: ChartConfig
  axes: boolean
  active: number | null
  top: number
  /** The dashed line the value is held against: the most at once, the load above which runs wait. */
  limit: number
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
        <ReferenceLine y={limit} stroke="var(--muted-foreground)" strokeDasharray="3 3" ifOverflow="extendDomain" />
        {on ? <ReferenceLine x={on.at} stroke="var(--muted-foreground)" strokeDasharray="2 2" /> : null}
        <Area dataKey={String(dataKey)} type={step ? 'stepAfter' : 'monotone'} stroke={`var(--color-${dataKey})`} fill={`var(--color-${dataKey})`} fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
        {on ? <ReferenceDot x={on.at} y={Number(on[dataKey])} r={3} fill={`var(--color-${dataKey})`} stroke="var(--card)" /> : null}
      </AreaChart>
    </ChartContainer>
  )
}

function ResultBars({ results, axes, active }: { results: readonly Result[]; axes: boolean; active: number | null }) {
  const top = niceTop(Math.max(1, ...results.map((one) => one.seconds)))
  return (
    <ChartContainer config={RESULTS} className="aspect-auto size-full">
      <BarChart data={results as Result[]} margin={axes ? AXES_MARGIN : MARGIN} barCategoryGap={1} accessibilityLayer={false}>
        {axes ? <CartesianGrid vertical={false} stroke="var(--border)" /> : null}
        <YAxis hide={!axes} width={axes ? 32 : 0} domain={[0, top]} ticks={[0, top]} tickFormatter={(v: number) => `${v} s`} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} interval={0} />
        {/* The labels are in the tooltip and the list: a narrow chart has no room for them under the bars. */}
        <XAxis hide dataKey="id" />
        <Bar dataKey="seconds" radius={[2, 2, 0, 0]} minPointSize={3} isAnimationActive={false}>
          {results.map((one, i) => (
            <Cell key={one.id} fill={FILL[one.state]} fillOpacity={active === null || active === i ? 1 : 0.4} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

/** A glance tile: its title and number in one row, a line in words, then its plot at a height of its own. Nothing overlays the plot but the tooltip. */
function Tile({ title, value, sub, subTone, testId, children }: { title: string; value: string; sub: string; subTone?: string; testId: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="bg-card flex min-w-0 flex-col gap-1 rounded-md border px-2 py-1.5" data-testid={testId}>
      <div className="flex min-w-0 items-baseline justify-between gap-2" data-testid={`${testId}-head`}>
        <h2 className="text-muted-foreground min-w-0 truncate text-[10px] font-medium tracking-wide uppercase" title={title}>
          {title}
        </h2>
        <p className="min-w-0 truncate text-sm font-semibold tabular-nums" data-testid={`${testId}-value`} title={value}>
          {value}
        </p>
      </div>
      <p className={`truncate text-xs ${subTone ?? 'text-muted-foreground'}`} title={sub}>
        {sub}
      </p>
      {children}
    </section>
  )
}
