import { Area, AreaChart, Bar, BarChart, Cell, ReferenceLine, XAxis, YAxis } from 'recharts'

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { counts, holding, queueNow, queueSaid, recentResults, resultsSaid, runningOver, strainSaid, type Result } from '@/glance'
import type { Machine } from '@/wire/api'

import type { RunView } from '../../queue/queue.ts'

/**
 * The three tiles a person reads at a glance: the queue (running of the most at once, and waiting),
 * the strain (the machine's load against the limit above which new runs wait), and the latest
 * results. Each says its numbers in words, and each chart is an image with its sentence: a chart is
 * never the only place a number is. Stacked as rows in a narrow container, side by side from 360 px.
 * Colours are the page's tokens (`--chart-*`), in both themes; a result's colour always has its word.
 */

const QUEUE: ChartConfig = { running: { label: 'Running', color: 'var(--chart-queue)' } }
const LOAD: ChartConfig = { load: { label: 'Load', color: 'var(--chart-load)' } }
const RESULTS: ChartConfig = { seconds: { label: 'Ran (s)', color: 'var(--chart-pass)' } }

const FILL: Record<Result['state'], string> = { passed: 'var(--chart-pass)', failed: 'var(--destructive)', cancelled: 'var(--muted-foreground)' }

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function Glance({ runs, machine, now }: { runs: readonly RunView[]; machine: Machine; now: number }) {
  const queue = queueNow(runs, machine)
  const over = runningOver(runs, now)
  const samples = machine.samples ?? []
  const results = recentResults(runs)
  const n = counts(results)
  const held = holding(machine)
  return (
    <div className="grid shrink-0 grid-cols-1 gap-2 @min-[360px]:grid-cols-3" data-testid="glance">
      <Tile title="Queue" value={`${queue.running}/${queue.most} running`} sub={queue.waiting ? `${queue.waiting} waiting` : 'none waiting'} said={queueSaid(queue)} testId="tile-queue">
        <ChartContainer config={QUEUE} className="aspect-auto size-full">
          <AreaChart data={over} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} accessibilityLayer={false}>
            <YAxis hide domain={[0, Math.max(queue.most, 1)]} allowDecimals={false} />
            <XAxis hide dataKey="at" />
            <ReferenceLine y={queue.most} stroke="var(--muted-foreground)" strokeDasharray="3 3" ifOverflow="extendDomain" />
            <Area dataKey="running" type="stepAfter" stroke="var(--color-running)" fill="var(--color-running)" fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
          </AreaChart>
        </ChartContainer>
      </Tile>
      <Tile
        title="Load"
        value={`${machine.load.toFixed(1)} / ${machine.loadAbove.toFixed(1)}`}
        sub={held ? 'holding new runs' : `${machine.cores} cores`}
        subTone={held ? 'text-destructive' : undefined}
        said={strainSaid(machine, samples)}
        testId="tile-load"
      >
        {samples.length > 1 ? (
          <ChartContainer config={LOAD} className="aspect-auto size-full">
            <AreaChart data={samples} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} accessibilityLayer={false}>
              <YAxis hide domain={[0, (max: number) => Math.max(max, machine.loadAbove) * 1.1]} />
              <XAxis hide dataKey="at" />
              <ReferenceLine y={machine.loadAbove} stroke="var(--muted-foreground)" strokeDasharray="3 3" />
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator labelFormatter={(_, payload) => (payload[0] ? time(Number(payload[0].payload.at)) : '')} />} />
              <Area dataKey="load" type="monotone" stroke="var(--color-load)" fill="var(--color-load)" fillOpacity={0.25} strokeWidth={2} isAnimationActive={false} />
            </AreaChart>
          </ChartContainer>
        ) : null}
      </Tile>
      <Tile
        title="Results"
        value={results.length ? `${n.passed} passed` : 'none yet'}
        sub={results.length ? `${n.failed} failed${n.cancelled ? ` · ${n.cancelled} cancelled` : ''}` : 'no run has ended'}
        subTone={n.failed ? 'text-destructive' : undefined}
        said={resultsSaid(results)}
        testId="tile-results"
      >
        {results.length ? (
          <ChartContainer config={RESULTS} className="aspect-auto size-full">
            <BarChart data={results} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} barCategoryGap={1} accessibilityLayer={false}>
              <YAxis hide domain={[0, (max: number) => Math.max(max, 1)]} />
              <XAxis hide dataKey="id" />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent hideIndicator labelFormatter={(_, payload) => (payload[0] ? `${String(payload[0].payload.label)} — ${String(payload[0].payload.state)}` : '')} />}
              />
              <Bar dataKey="seconds" radius={[2, 2, 0, 0]} minPointSize={3} isAnimationActive={false}>
                {results.map((one) => (
                  <Cell key={one.id} fill={FILL[one.state]} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        ) : null}
      </Tile>
    </div>
  )
}

function Tile({ title, value, sub, subTone, said, testId, children }: { title: string; value: string; sub: string; subTone?: string; said: string; testId: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="bg-card flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 @min-[360px]:flex-col @min-[360px]:items-stretch" data-testid={testId}>
      <div className="min-w-0 flex-1">
        <h2 className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">{title}</h2>
        <p className="truncate text-sm font-semibold tabular-nums" data-testid={`${testId}-value`}>
          {value}
        </p>
        <p className={`truncate text-xs ${subTone ?? 'text-muted-foreground'}`}>{sub}</p>
      </div>
      {/* The chart is a picture of what the sentence says; the sentence is what a screen reader reads. */}
      <div role="img" aria-label={said} title={said} className="h-9 w-16 shrink-0 @min-[360px]:h-10 @min-[360px]:w-full">
        {children}
      </div>
    </section>
  )
}
