import { useId, useMemo, useRef, useState } from 'react'
import { cx } from './ui'

const W = 320
const H = 96
const PAD_TOP = 8

/** Single-series area chart with a crosshair tooltip. Values share one axis starting at 0. */
export function UsageChart({
  title,
  points,
  format,
  limit,
  rangeLabel,
  loading,
}: {
  title: string
  points: [number, number][]
  format: (value: number) => string
  /** Optional reference line, e.g. the memory limit. */
  limit?: number | null
  rangeLabel: string
  loading?: boolean
}) {
  const gradient = useId()
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<number | null>(null)

  const geometry = useMemo(() => {
    if (points.length < 2) return null
    const t0 = points[0][0]
    const t1 = points[points.length - 1][0]
    const values = points.map((p) => p[1])
    const peak = Math.max(...values)
    // Include the limit only when usage gets near it, so small usage stays readable.
    const showLimit = limit != null && limit > 0 && peak > limit * 0.4
    const top = Math.max(peak, showLimit ? limit! : 0) * 1.12 || 1
    const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * W
    const y = (v: number) => PAD_TOP + (1 - v / top) * (H - PAD_TOP)
    const line = points
      .map(
        ([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`,
      )
      .join('')
    const area = `${line}L${W},${H}L0,${H}Z`
    return {
      x,
      y,
      line,
      area,
      peak,
      min: Math.min(...values),
      top,
      limitY: showLimit ? y(limit!) : null,
    }
  }, [points, limit])

  const current = points.length ? points[points.length - 1][1] : null
  const hovered = hover != null ? points[hover] : null

  const onPointer = (clientX: number) => {
    const el = box.current
    if (!el || !geometry) return
    const rect = el.getBoundingClientRect()
    const fraction = Math.min(
      1,
      Math.max(0, (clientX - rect.left) / rect.width),
    )
    setHover(Math.round(fraction * (points.length - 1)))
  }

  const summary = geometry
    ? `${title}: now ${format(current!)}, peak ${format(geometry.peak)}, low ${format(geometry.min)} over the last ${rangeLabel}`
    : `${title}: no data`

  return (
    <figure className="min-w-0">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-faint uppercase">
          {title}
        </span>
        {limit != null && limit > 0 ? (
          <span className="text-[11px] text-faint">limit {format(limit)}</span>
        ) : null}
      </figcaption>
      <p className="mt-0.5 text-xl font-bold tabular-nums">
        {hovered ? format(hovered[1]) : current != null ? format(current) : '–'}
        <span className="ml-1.5 text-xs font-medium text-muted">
          {hovered ? timeLabel(hovered[0]) : 'now'}
        </span>
      </p>
      <div
        ref={box}
        role="img"
        aria-label={summary}
        className={cx(
          'relative mt-1.5 h-24 touch-pan-y select-none',
          loading && 'opacity-60',
        )}
        onPointerMove={(e) => onPointer(e.clientX)}
        onPointerDown={(e) => onPointer(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      >
        {geometry ? (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible"
          >
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--accent)" stopOpacity="0.16" />
                <stop offset="1" stopColor="var(--accent)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <line
              x1="0"
              x2={W}
              y1={H}
              y2={H}
              stroke="var(--line)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1="0"
              x2={W}
              y1={geometry.y(geometry.top / 1.12 / 2)}
              y2={geometry.y(geometry.top / 1.12 / 2)}
              stroke="var(--line)"
              strokeWidth="1"
              opacity="0.6"
              vectorEffect="non-scaling-stroke"
            />
            {geometry.limitY != null ? (
              <line
                x1="0"
                x2={W}
                y1={geometry.limitY}
                y2={geometry.limitY}
                stroke="var(--warn)"
                strokeWidth="1"
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            <path d={geometry.area} fill={`url(#${gradient})`} />
            <path
              d={geometry.line}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : (
          <div className="flex h-full items-center justify-center rounded-xl bg-surface-2/60 text-xs text-faint">
            {loading ? 'Loading…' : 'No data'}
          </div>
        )}
        {geometry && hovered ? (
          <div
            className="pointer-events-none absolute inset-y-0 w-px bg-fg/40"
            style={{ left: `${(geometry.x(hovered[0]) / W) * 100}%` }}
          >
            <span
              className="absolute size-2 -translate-x-[3.5px] -translate-y-1 rounded-full border-2 border-surface bg-accent"
              style={{ top: `${(geometry.y(hovered[1]) / H) * 100}%` }}
            />
          </div>
        ) : null}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-faint tabular-nums">
        <span>{rangeLabel} ago</span>
        {geometry ? <span>peak {format(geometry.peak)}</span> : null}
        <span>now</span>
      </div>
    </figure>
  )
}

function timeLabel(unixSeconds: number) {
  const d = new Date(unixSeconds * 1000)
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return sameDay
    ? time
    : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}
