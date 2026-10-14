import {
  ArrowDown,
  Download,
  Pause,
  Play,
  RotateCw,
  Search,
  WrapText,
  Clock,
  History,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, type PodSummary } from '../lib/api'
import { logLevel, splitTimestamp, type LogLevel } from '../lib/format'
import { useStored } from '../lib/hooks'
import { cx } from './ui'

const MAX_LINES = 5000
const TAIL_OPTIONS = [100, 500, 2000, 5000]

type Status = 'connecting' | 'live' | 'ended' | 'disconnected' | 'failed'

type Line = { id: number; ts: string | null; text: string; level: LogLevel }

const LEVEL_CLASS: Record<Exclude<LogLevel, null>, string> = {
  error: 'border-l-bad text-[#ff9b9b]',
  warn: 'border-l-warn text-[#ffd479]',
  info: 'border-l-transparent',
  debug: 'border-l-transparent opacity-60',
}

export function LogViewer({
  namespace,
  pods,
  pod,
  onPodChange,
}: {
  namespace: string
  pods: PodSummary[]
  pod: string | null
  onPodChange: (pod: string) => void
}) {
  // Default to the newest pod that is running, else the newest pod.
  const fallbackPod = (
    pods.find((p) => p.phase === 'Running' && !p.terminating) ?? pods[0]
  )?.name
  const podName = pod && pods.some((p) => p.name === pod) ? pod : fallbackPod
  const selected = pods.find((p) => p.name === podName)
  const containers = useMemo(
    () => [
      ...(selected?.containers.map((c) => c.name) ?? []),
      ...(selected?.initContainers.map((c) => c.name) ?? []),
    ],
    [selected],
  )
  const [container, setContainer] = useState<string | null>(null)
  const containerName =
    container && containers.includes(container) ? container : containers[0]
  const [tail, setTail] = useStored('kubedash.logs.tail', 500)
  // Pausing freezes the view; lines that arrive meanwhile are buffered and shown on resume.
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  const flushRef = useRef<() => void>(() => {})
  const [previous, setPrevious] = useState(false)
  const [wrap, setWrap] = useStored('kubedash.logs.wrap', true)
  const [timestamps, setTimestamps] = useStored(
    'kubedash.logs.timestamps',
    false,
  )
  const [filter, setFilter] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [status, setStatus] = useState<Status>('connecting')
  const [failure, setFailure] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [session, setSession] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!podName) return
    setLines([])
    setFailure(null)
    setStatus('connecting')
    setAtBottom(true)
    setPaused(false)
    pausedRef.current = false
    let nextId = 0
    let pending: Line[] = []
    let frame = 0
    const flush = () => {
      frame = 0
      if (pausedRef.current) {
        if (pending.length > MAX_LINES) pending = pending.slice(-MAX_LINES)
        return
      }
      const batch = pending
      pending = []
      setLines((current) => {
        const merged = current.concat(batch)
        return merged.length > MAX_LINES ? merged.slice(-MAX_LINES) : merged
      })
    }
    flushRef.current = flush
    const source = new EventSource(
      api.logsUrl(namespace, podName, {
        container: containerName,
        tail,
        previous,
        follow: !previous,
      }),
    )
    source.addEventListener('open', () => setStatus('live'))
    source.addEventListener('line', (event) => {
      const { ts, text } = splitTimestamp((event as MessageEvent<string>).data)
      pending.push({ id: nextId++, ts, text, level: logLevel(text) })
      if (!frame) frame = requestAnimationFrame(flush)
    })
    source.addEventListener('end', () => {
      source.close()
      setStatus('ended')
    })
    source.addEventListener('failure', (event) => {
      source.close()
      setFailure((event as MessageEvent<string>).data)
      setStatus('failed')
    })
    // Connection problems: stop instead of letting EventSource re-tail and duplicate lines.
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) {
        source.close()
        setStatus((s) => (s === 'ended' || s === 'failed' ? s : 'disconnected'))
      }
    }
    return () => {
      source.close()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [namespace, podName, containerName, tail, previous, session])

  useEffect(() => {
    pausedRef.current = paused
    if (!paused) flushRef.current()
  }, [paused])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return needle
      ? lines.filter((l) => l.text.toLowerCase().includes(needle))
      : lines
  }, [lines, filter])

  // Stick to the bottom while new lines arrive, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [visible, atBottom, wrap, timestamps])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  const download = () => {
    const body = lines
      .map((l) => (l.ts ? `${l.ts} ${l.text}` : l.text))
      .join('\n')
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${podName}${containerName ? `-${containerName}` : ''}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!pods.length)
    return (
      <p className="py-10 text-center text-sm text-muted">
        No pods to show logs for.
      </p>
    )

  const selectClass =
    'h-10 min-w-0 rounded-xl border border-line bg-surface px-3 text-[16px] sm:text-sm font-medium outline-none focus:border-accent/60'

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <select
          aria-label="Pod"
          value={podName}
          onChange={(e) => onPodChange(e.target.value)}
          className={cx(selectClass, 'font-mono')}
        >
          {pods.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
              {p.terminating
                ? ' (terminating)'
                : p.ready
                  ? ''
                  : ` (${p.phase.toLowerCase()})`}
            </option>
          ))}
        </select>
        <select
          aria-label="Lines"
          value={tail}
          onChange={(e) => setTail(Number(e.target.value))}
          className={selectClass}
        >
          {TAIL_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n} lines
            </option>
          ))}
        </select>
      </div>

      {containers.length > 1 ? (
        <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4">
          {containers.map((c) => (
            <button
              key={c}
              onClick={() => setContainer(c)}
              className={cx(
                'h-8 shrink-0 rounded-full border px-3 text-xs font-medium',
                c === containerName
                  ? 'border-transparent bg-fg text-bg'
                  : 'border-line bg-surface text-muted',
              )}
            >
              {c}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter lines"
            className="h-10 w-full rounded-xl border border-line bg-surface pr-3 pl-9 text-[16px] outline-none placeholder:text-faint focus:border-accent/60 sm:text-sm"
          />
        </label>
        <Toggle
          label={paused ? 'Resume' : 'Pause'}
          active={paused}
          disabled={previous || status !== 'live'}
          onClick={() => setPaused(!paused)}
        >
          {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
        </Toggle>
        <Toggle
          label="Previous container (before last restart)"
          active={previous}
          onClick={() => setPrevious(!previous)}
        >
          <History className="size-4" />
        </Toggle>
        <Toggle label="Wrap lines" active={wrap} onClick={() => setWrap(!wrap)}>
          <WrapText className="size-4" />
        </Toggle>
        <Toggle
          label="Timestamps"
          active={timestamps}
          onClick={() => setTimestamps(!timestamps)}
        >
          <Clock className="size-4" />
        </Toggle>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-line bg-log-bg shadow-inner">
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2 text-[11px] text-white/50">
          <StatusPill status={status} previous={previous} paused={paused} />
          <span className="ml-auto tabular-nums">
            {filter ? `${visible.length} / ` : ''}
            {lines.length} lines
          </span>
          <button
            aria-label="Reconnect"
            title="Reload"
            onClick={() => setSession((s) => s + 1)}
            className="rounded-md p-1 hover:bg-white/10 hover:text-white"
          >
            <RotateCw className="size-3.5" />
          </button>
          <button
            aria-label="Download logs"
            title="Download"
            onClick={download}
            className="rounded-md p-1 hover:bg-white/10 hover:text-white"
          >
            <Download className="size-3.5" />
          </button>
        </div>
        <div
          ref={scroller}
          onScroll={onScroll}
          className={cx(
            'h-[62dvh] min-h-72 overflow-auto py-2 font-mono text-[11.5px] leading-[1.55] text-log-fg sm:text-xs',
            wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre',
          )}
        >
          {failure ? <p className="px-3 text-[#ff9b9b]">{failure}</p> : null}
          {!failure && status !== 'connecting' && lines.length === 0 ? (
            <p className="px-3 text-white/40">
              No log output{previous ? ' from the previous container' : ''}.
            </p>
          ) : null}
          {visible.map((l) => (
            <div
              key={l.id}
              className={cx(
                'border-l-2 px-3 hover:bg-white/[0.04]',
                l.level ? LEVEL_CLASS[l.level] : 'border-l-transparent',
              )}
            >
              {timestamps && l.ts ? (
                <span className="mr-2 text-white/35 select-none">
                  {formatTs(l.ts)}
                </span>
              ) : null}
              {l.text}
            </div>
          ))}
        </div>
        {!atBottom ? (
          <button
            onClick={() => setAtBottom(true)}
            className="fade-up absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-2 text-xs font-semibold text-accent-fg shadow-lg"
          >
            <ArrowDown className="size-3.5" /> Latest
          </button>
        ) : null}
      </div>
    </div>
  )
}

function formatTs(ts: string) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  const sameDay = d.toDateString() === new Date().toDateString()
  const time = d.toLocaleTimeString(undefined, { hour12: false })
  return sameDay
    ? time
    : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

function StatusPill({
  status,
  previous,
  paused,
}: {
  status: Status
  previous: boolean
  paused: boolean
}) {
  const map: Record<Status, [string, string]> = {
    connecting: ['bg-white/40', 'Connecting…'],
    live: paused
      ? ['bg-warn', 'Paused']
      : ['bg-ok pulse text-ok', previous ? 'Previous container' : 'Live'],
    ended: ['bg-white/40', previous ? 'Previous container' : 'Stream ended'],
    disconnected: ['bg-warn', 'Disconnected'],
    failed: ['bg-bad', 'Error'],
  }
  const [dot, label] = map[status]
  return (
    <span className="inline-flex items-center gap-1.5 font-medium">
      <span className={cx('size-1.5 rounded-full', dot)} />
      {label}
    </span>
  )
}

function Toggle({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex size-10 shrink-0 items-center justify-center rounded-xl border transition active:scale-95 disabled:opacity-40',
        active
          ? 'border-accent/40 bg-accent/12 text-accent'
          : 'border-line bg-surface text-muted',
      )}
    >
      {children}
    </button>
  )
}
