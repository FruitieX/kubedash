import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ExternalLink,
  MoreVertical,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  Server,
  Star,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { api, workloadPath, type Overview, type Workload } from '../lib/api'
import {
  age,
  hasIssue,
  HEALTH_ORDER,
  shortImage,
  workloadKey,
} from '../lib/format'
import { navigate, useNow, useStored } from '../lib/hooks'
import {
  Card,
  ConfirmDialog,
  cx,
  IconButton,
  Skeleton,
  StatusDot,
  useToast,
} from './ui'

type Filter = 'all' | 'issues' | 'pinned'

export function Dashboard({
  overview,
  error,
  loading,
  refresh,
  readOnly,
  pinned,
  togglePin,
}: {
  overview: Overview | null
  error: Error | null
  loading: boolean
  refresh: () => Promise<void>
  readOnly: boolean
  pinned: string[]
  togglePin: (key: string) => void
}) {
  const [query, setQuery] = useStored('kubedash.query', '')
  const [filter, setFilter] = useStored<Filter>('kubedash.filter', 'all')
  const [namespace, setNamespace] = useStored<string | null>(
    'kubedash.namespace',
    null,
  )
  const [spinning, setSpinning] = useState(false)
  const now = useNow()

  const workloads = overview?.workloads ?? []
  const namespaces = useMemo(() => {
    const counts = new Map<string, number>()
    for (const w of workloads)
      counts.set(w.namespace, (counts.get(w.namespace) ?? 0) + 1)
    return [...counts.entries()].sort(([a], [b]) =>
      a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b),
    )
  }, [workloads])

  const issues = workloads.filter(hasIssue)
  const healthy = workloads.filter((w) => w.health === 'healthy').length
  const nodesReady = overview?.nodes.filter((n) => n.ready).length ?? 0

  const visible = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    return workloads.filter((w) => {
      if (namespace && w.namespace !== namespace) return false
      if (filter === 'issues' && !hasIssue(w)) return false
      if (filter === 'pinned' && !pinned.includes(workloadKey(w))) return false
      const haystack =
        `${w.name} ${w.namespace} ${w.kind} ${w.images.join(' ')}`.toLowerCase()
      return terms.every((t) => haystack.includes(t))
    })
  }, [workloads, query, namespace, filter, pinned])

  // Pinned and broken workloads float to the top; the rest is grouped by namespace.
  const sections = useMemo(() => {
    const pinnedItems = visible.filter((w) => pinned.includes(workloadKey(w)))
    const attention = visible
      .filter((w) => hasIssue(w) && !pinned.includes(workloadKey(w)))
      .sort(
        (a, b) =>
          HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health),
      )
    const taken = new Set([...pinnedItems, ...attention].map(workloadKey))
    const groups = new Map<string, Workload[]>()
    for (const w of visible) {
      if (taken.has(workloadKey(w))) continue
      groups.set(w.namespace, [...(groups.get(w.namespace) ?? []), w])
    }
    const out: { title: string; items: Workload[]; tone?: 'attention' }[] = []
    if (attention.length)
      out.push({
        title: 'Needs attention',
        items: attention,
        tone: 'attention',
      })
    if (pinnedItems.length) out.push({ title: 'Pinned', items: pinnedItems })
    for (const [ns] of namespaces) {
      const items = groups.get(ns)
      if (items?.length) out.push({ title: ns, items })
    }
    return out
  }, [visible, pinned, namespaces])

  const onRefresh = async () => {
    setSpinning(true)
    await Promise.all([refresh(), new Promise((r) => setTimeout(r, 400))])
    setSpinning(false)
  }

  return (
    <div className="mx-auto min-h-dvh max-w-3xl pb-safe">
      <header className="pt-safe sticky top-0 z-20 border-b border-line/70 bg-bg/80 backdrop-blur-xl">
        <div className="flex items-center gap-3 px-4 pt-3 pb-2">
          <img src="/icon.svg" alt="" className="size-9 rounded-xl shadow-sm" />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg leading-tight font-bold tracking-tight">
              kubedash
            </h1>
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Server className="size-3" />
              {overview ? (
                <span>
                  {nodesReady}/{overview.nodes.length} nodes ready ·{' '}
                  {workloads.length} workloads
                </span>
              ) : (
                <span>Connecting…</span>
              )}
            </p>
          </div>
          <IconButton label="Refresh" onClick={onRefresh}>
            <RefreshCw
              className={cx(
                'size-5',
                (spinning || (loading && !overview)) && 'animate-spin',
              )}
            />
          </IconButton>
        </div>

        <div className="px-4 pb-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search services, images…"
              enterKeyHint="search"
              className="h-11 w-full rounded-xl border border-line bg-surface pr-10 pl-10 text-[16px] outline-none placeholder:text-faint focus:border-accent/60 focus:ring-4 focus:ring-accent/10"
            />
            {query ? (
              <button
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg p-1.5 text-faint hover:text-fg"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </label>
        </div>

        <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-3">
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
            All <Count>{workloads.length}</Count>
          </Chip>
          <Chip
            active={filter === 'issues'}
            onClick={() => setFilter(filter === 'issues' ? 'all' : 'issues')}
            tone={issues.length ? 'bad' : undefined}
          >
            Issues <Count>{issues.length}</Count>
          </Chip>
          <Chip
            active={filter === 'pinned'}
            onClick={() => setFilter(filter === 'pinned' ? 'all' : 'pinned')}
          >
            <Star className="size-3.5" /> Pinned <Count>{pinned.length}</Count>
          </Chip>
          <span className="mx-1 w-px shrink-0 bg-line" />
          <Chip active={namespace === null} onClick={() => setNamespace(null)}>
            All namespaces
          </Chip>
          {namespaces.map(([ns, count]) => (
            <Chip
              key={ns}
              active={namespace === ns}
              onClick={() => setNamespace(namespace === ns ? null : ns)}
            >
              {ns} <Count>{count}</Count>
            </Chip>
          ))}
        </div>
      </header>

      <main className="px-4 pt-4">
        {overview ? (
          <Summary
            healthy={healthy}
            issues={issues.length}
            nodesReady={nodesReady}
            nodes={overview.nodes.length}
          />
        ) : null}

        {error ? (
          <Card className="mb-4 border-bad/30 bg-bad/5 p-4 text-sm">
            <p className="font-semibold text-bad">Can't reach the cluster</p>
            <p className="mt-1 text-muted">{error.message}</p>
          </Card>
        ) : null}

        {!overview && loading ? <ListSkeleton /> : null}

        {overview && sections.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted">
            No workloads match.
            <button
              className="ml-1 font-semibold text-accent"
              onClick={() => {
                setQuery('')
                setFilter('all')
                setNamespace(null)
              }}
            >
              Reset filters
            </button>
          </div>
        ) : null}

        {sections.map((section) => (
          <section key={section.title} className="mb-6">
            <h2
              className={cx(
                'mb-2 px-1 text-xs font-semibold tracking-wider uppercase',
                section.tone === 'attention' ? 'text-bad' : 'text-faint',
              )}
            >
              {section.title}
            </h2>
            <Card className="divide-y divide-line overflow-hidden">
              {section.items.map((w) => (
                <WorkloadRow
                  key={workloadKey(w)}
                  workload={w}
                  now={now}
                  readOnly={readOnly}
                  pinned={pinned.includes(workloadKey(w))}
                  togglePin={() => togglePin(workloadKey(w))}
                  onRestarted={refresh}
                />
              ))}
            </Card>
          </section>
        ))}
      </main>
    </div>
  )
}

function Summary({
  healthy,
  issues,
  nodesReady,
  nodes,
}: {
  healthy: number
  issues: number
  nodesReady: number
  nodes: number
}) {
  return (
    <div className="fade-up mb-5 grid grid-cols-3 gap-2">
      <Stat label="Healthy" value={healthy} tone="text-ok" />
      <Stat
        label="Issues"
        value={issues}
        tone={issues ? 'text-bad' : 'text-fg'}
      />
      <Stat
        label="Nodes"
        value={`${nodesReady}/${nodes}`}
        tone={nodesReady < nodes ? 'text-bad' : 'text-fg'}
      />
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone: string
}) {
  return (
    <Card className="px-3.5 py-3">
      <p className="text-[11px] font-semibold tracking-wider text-faint uppercase">
        {label}
      </p>
      <p className={cx('mt-0.5 text-2xl font-bold tabular-nums', tone)}>
        {value}
      </p>
    </Card>
  )
}

function Chip({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean
  tone?: 'bad'
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition active:scale-95',
        active
          ? 'border-transparent bg-fg text-bg'
          : tone === 'bad'
            ? 'border-bad/30 bg-bad/8 text-bad'
            : 'border-line bg-surface text-muted hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

function Count({ children }: { children: React.ReactNode }) {
  return <span className="tabular-nums opacity-60">{children}</span>
}

function WorkloadRow({
  workload: w,
  now,
  readOnly,
  pinned,
  togglePin,
  onRestarted,
}: {
  workload: Workload
  now: number
  readOnly: boolean
  pinned: boolean
  togglePin: () => void
  onRestarted: () => Promise<void>
}) {
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const image = w.images[0] ? shortImage(w.images[0]) : null
  const since = w.runningSince ?? w.restartedAt ?? w.createdAt
  const path = workloadPath(w)

  return (
    <div className="group relative flex items-stretch transition hover:bg-surface-2/60 active:bg-surface-2">
      <a
        href={path}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) return
          e.preventDefault()
          navigate(path)
        }}
        className="flex min-w-0 flex-1 items-start gap-3 py-3.5 pl-4"
      >
        <StatusDot health={w.health} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{w.name}</span>
            {pinned ? (
              <Star className="size-3.5 shrink-0 fill-warn text-warn" />
            ) : null}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
            {image ? (
              <span className="truncate font-mono text-[11px]">
                {image.name}
                <span className="text-faint">:{image.tag}</span>
              </span>
            ) : null}
            <span className="text-faint">·</span>
            <span className="shrink-0">{age(since, now)}</span>
            {w.podRestarts > 0 ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-warn">
                <RotateCcw className="size-3" />
                {w.podRestarts}
              </span>
            ) : null}
          </p>
          {w.problem ? (
            <p className="mt-1 line-clamp-2 text-xs font-medium text-bad">
              {w.problem}
            </p>
          ) : null}
        </div>
        <span
          className={cx(
            'mt-0.5 shrink-0 rounded-lg px-2 py-0.5 font-mono text-xs font-semibold tabular-nums',
            w.ready >= w.desired && w.desired > 0
              ? 'bg-ok/10 text-ok'
              : 'bg-surface-2 text-muted',
          )}
        >
          {w.ready}/{w.desired}
        </span>
      </a>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            aria-label={`Actions for ${w.name}`}
            className="flex w-11 shrink-0 items-start justify-center pt-3.5 text-faint hover:text-fg focus-visible:outline-none data-[state=open]:text-fg"
          >
            <MoreVertical className="size-5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className={menuClass}
          >
            {w.urls.map((url) => (
              <DropdownMenu.Item key={url} asChild className={itemClass}>
                <a href={url} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  <span className="truncate">
                    {url.replace(/^https:\/\//, '')}
                  </span>
                </a>
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Item
              className={itemClass}
              onSelect={() => navigate(`${path}?tab=logs`)}
            >
              <ScrollText className="size-4" /> View logs
            </DropdownMenu.Item>
            <DropdownMenu.Item className={itemClass} onSelect={togglePin}>
              <Star className="size-4" /> {pinned ? 'Unpin' : 'Pin to top'}
            </DropdownMenu.Item>
            {!readOnly ? (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-line" />
                <DropdownMenu.Item
                  className={itemClass}
                  onSelect={() => setConfirming(true)}
                >
                  <RotateCcw className="size-4" /> Restart…
                </DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Restart ${w.name}?`}
        description={restartDescription(w)}
        confirmLabel="Restart"
        onConfirm={async () => {
          try {
            await api.restart(w)
            toast('ok', `Restarting ${w.name}`)
            await onRestarted()
          } catch (err) {
            toast('error', `Restart failed: ${(err as Error).message}`)
          }
        }}
      />
    </div>
  )
}

export function restartDescription(w: Workload) {
  return (
    <>
      Performs a rollout restart of{' '}
      <span className="font-mono text-fg">
        {w.namespace}/{w.name}
      </span>
      . Pods are replaced{' '}
      {w.kind === 'deployment'
        ? 'according to the deployment strategy'
        : 'one at a time'}
      {w.desired <= 1 ? ', so expect a short interruption.' : '.'}
    </>
  )
}

export const menuClass =
  'z-50 min-w-48 max-w-[calc(100vw-24px)] rounded-2xl border border-line bg-surface p-1.5 shadow-2xl sheet-in'
export const itemClass =
  'flex h-10 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-sm outline-none select-none data-[highlighted]:bg-surface-2 text-fg'

function ListSkeleton() {
  return (
    <div className="space-y-2">
      <div className="mb-5 grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[68px] rounded-2xl" />
        ))}
      </div>
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-[62px] rounded-2xl" />
      ))}
    </div>
  )
}
