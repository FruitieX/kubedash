import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as Tabs from '@radix-ui/react-tabs'
import {
  AlertTriangle,
  ArrowLeft,
  Box,
  ExternalLink,
  MoreVertical,
  RotateCcw,
  ScrollText,
  Star,
  Trash2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  api,
  type ContainerSummary,
  type EventSummary,
  type HistoryRange,
  type PodSummary,
  type Workload,
  type WorkloadDetail as Detail,
} from '../lib/api'
import {
  age,
  formatBytes,
  formatCpu,
  KIND_LABEL,
  shortImage,
  workloadKey,
} from '../lib/format'
import { goBack, useNow, usePoll, useStored } from '../lib/hooks'
import { FluxCard } from './Flux'
import { UsageChart } from './UsageChart'
import { itemClass, menuClass, restartDescription } from './Dashboard'
import { LogViewer } from './LogViewer'
import {
  ActionMenu,
  Button,
  Card,
  ConfirmDialog,
  cx,
  HealthBadge,
  IconButton,
  Meter,
  Skeleton,
  StatusDot,
  useToast,
} from './ui'

type Tab = 'pods' | 'logs' | 'events'

export function WorkloadDetail({
  kind,
  namespace,
  name,
  readOnly,
  pinned,
  togglePin,
}: {
  kind: string
  namespace: string
  name: string
  readOnly: boolean
  pinned: string[]
  togglePin: (key: string) => void
}) {
  const toast = useToast()
  const now = useNow(5000)
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab')
    return t === 'logs' || t === 'events' ? t : 'pods'
  })
  const [logPod, setLogPod] = useState<string | null>(null)
  const [confirmRestart, setConfirmRestart] = useState(false)
  // Poll quickly while something is changing, slowly otherwise.
  const [fastUntil, setFastUntil] = useState(0)
  const key = `${kind}/${namespace}/${name}`
  const fast = now < fastUntil
  const { data, error, refresh } = usePoll<Detail>(
    () => api.workload(kind, namespace, name),
    fast ? 2000 : 5000,
    key,
  )
  const w = data?.workload
  const rolling = w?.health === 'progressing'

  useEffect(() => {
    if (rolling) setFastUntil(Date.now() + 10_000)
  }, [rolling, data])

  useEffect(() => {
    document.title = `${name} · kubedash`
    return () => {
      document.title = 'kubedash'
    }
  }, [name])

  const selectTab = (next: Tab) => {
    setTab(next)
    const url = new URL(window.location.href)
    if (next === 'pods') url.searchParams.delete('tab')
    else url.searchParams.set('tab', next)
    window.history.replaceState(window.history.state, '', url)
  }

  const isPinned = pinned.includes(key)
  const warnings = data?.events.filter((e) => e.type === 'Warning').length ?? 0

  return (
    <div className="mx-auto min-h-dvh max-w-3xl pb-safe">
      <header className="pt-safe sticky top-0 z-20 border-b border-line/70 bg-bg/80 backdrop-blur-xl">
        <div className="flex h-14 items-center gap-1 px-2">
          <IconButton label="Back" onClick={goBack}>
            <ArrowLeft className="size-5" />
          </IconButton>
          <div className="min-w-0 flex-1 px-1">
            <p className="truncate leading-tight font-semibold">{name}</p>
            <p className="truncate text-xs text-muted">
              {namespace} ·{' '}
              {KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? kind}
            </p>
          </div>
          <IconButton
            label={isPinned ? 'Unpin' : 'Pin to top'}
            onClick={() => togglePin(key)}
          >
            <Star className={cx('size-5', isPinned && 'fill-warn text-warn')} />
          </IconButton>
        </div>
      </header>

      <main className="px-4 pt-4">
        {error && !data ? (
          <Card className="border-bad/30 bg-bad/5 p-4 text-sm">
            <p className="font-semibold text-bad">Couldn't load {name}</p>
            <p className="mt-1 text-muted">{error.message}</p>
          </Card>
        ) : null}

        {!data && !error ? (
          <div className="space-y-3">
            <Skeleton className="h-44 rounded-2xl" />
            <Skeleton className="h-11 rounded-xl" />
            <Skeleton className="h-36 rounded-2xl" />
          </div>
        ) : null}

        {w && data ? (
          <>
            <Card className="fade-up p-4">
              <div className="flex items-start justify-between gap-3">
                <HealthBadge health={w.health} />
                <span className="font-mono text-2xl font-bold tabular-nums">
                  {w.ready}
                  <span className="text-faint">/{w.desired}</span>
                </span>
              </div>

              {w.problem ? (
                <div className="mt-3 flex gap-2 rounded-xl bg-bad/8 p-3 text-sm text-bad">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <p className="min-w-0 break-words">{w.problem}</p>
                </div>
              ) : null}

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Fact
                  label="Last restart"
                  value={
                    w.restartedAt ? `${age(w.restartedAt, now)} ago` : 'Never'
                  }
                />
                <Fact label="Created" value={`${age(w.createdAt, now)} ago`} />
                <Fact
                  label="Pod restarts"
                  value={String(w.podRestarts)}
                  warn={w.podRestarts > 0}
                />
                <Fact label="Updated" value={`${w.updated}/${w.desired}`} />
              </dl>

              <div className="mt-4 space-y-1.5">
                {w.images.map((img) => {
                  const s = shortImage(img)
                  return (
                    <p
                      key={img}
                      title={img}
                      className="flex items-center gap-2 truncate rounded-lg bg-surface-2 px-2.5 py-1.5 font-mono text-xs"
                    >
                      <Box className="size-3.5 shrink-0 text-faint" />
                      <span className="truncate">
                        {s.name}
                        <span className="text-muted">:{s.tag}</span>
                      </span>
                    </p>
                  )
                })}
              </div>

              <div
                className={cx(
                  'mt-4 grid gap-2',
                  w.urls.length ? 'grid-cols-2' : 'grid-cols-1',
                )}
              >
                {!readOnly ? (
                  <Button
                    variant="primary"
                    onClick={() => setConfirmRestart(true)}
                    busy={rolling && now < fastUntil}
                    className={w.urls.length ? '' : 'w-full'}
                  >
                    {rolling ? null : <RotateCcw className="size-4" />}
                    {rolling ? 'Rolling out…' : 'Restart'}
                  </Button>
                ) : null}
                {w.urls.length ? (
                  <Button
                    onClick={() =>
                      window.open(w.urls[0], '_blank', 'noreferrer')
                    }
                  >
                    <ExternalLink className="size-4" /> Open
                  </Button>
                ) : null}
              </div>
              {w.urls.length > 1 ? (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {w.urls.slice(1).map((u) => (
                    <a
                      key={u}
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent"
                    >
                      {u.replace(/^https:\/\//, '')}
                    </a>
                  ))}
                </div>
              ) : null}
            </Card>

            {data.flux ? (
              <FluxCard
                flux={data.flux}
                now={now}
                readOnly={readOnly}
                onReconciled={() => {
                  setFastUntil(Date.now() + 30_000)
                  void refresh()
                }}
              />
            ) : null}

            {w.usage || data.history ? (
              <UsageCard workload={w} history={data.history} />
            ) : null}

            <Tabs.Root
              value={tab}
              onValueChange={(v) => selectTab(v as Tab)}
              className="mt-5"
            >
              <Tabs.List className="sticky top-[calc(env(safe-area-inset-top)+56px)] z-10 -mx-4 grid grid-cols-3 gap-1 bg-bg/80 px-4 py-2 backdrop-blur-xl">
                <TabTrigger value="pods">
                  Pods <span className="opacity-60">{data.pods.length}</span>
                </TabTrigger>
                <TabTrigger value="logs">Logs</TabTrigger>
                <TabTrigger value="events">
                  Events
                  {warnings ? (
                    <span className="rounded-full bg-warn/15 px-1.5 text-[11px] text-warn">
                      {warnings}
                    </span>
                  ) : null}
                </TabTrigger>
              </Tabs.List>

              <Tabs.Content
                value="pods"
                className="mt-2 space-y-3 outline-none"
              >
                {data.pods.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted">
                    No pods.
                  </p>
                ) : null}
                {data.pods.map((pod) => (
                  <PodCard
                    key={pod.name}
                    pod={pod}
                    namespace={namespace}
                    now={now}
                    readOnly={readOnly}
                    onLogs={() => {
                      setLogPod(pod.name)
                      selectTab('logs')
                    }}
                    onDeleted={() => {
                      setFastUntil(Date.now() + 30_000)
                      void refresh()
                    }}
                  />
                ))}
              </Tabs.Content>

              <Tabs.Content
                value="logs"
                className="mt-2 outline-none"
                forceMount
                hidden={tab !== 'logs'}
              >
                {tab === 'logs' ? (
                  <LogViewer
                    namespace={namespace}
                    pods={data.pods}
                    pod={logPod}
                    onPodChange={setLogPod}
                  />
                ) : null}
              </Tabs.Content>

              <Tabs.Content value="events" className="mt-2 outline-none">
                <Events events={data.events} now={now} />
              </Tabs.Content>
            </Tabs.Root>

            <ConfirmDialog
              open={confirmRestart}
              onOpenChange={setConfirmRestart}
              title={`Restart ${w.name}?`}
              description={restartDescription(w)}
              confirmLabel="Restart"
              onConfirm={async () => {
                try {
                  await api.restart(w)
                  toast('ok', `Restarting ${w.name}`)
                  setFastUntil(Date.now() + 60_000)
                  await refresh()
                } catch (err) {
                  toast('error', `Restart failed: ${(err as Error).message}`)
                }
              }}
            />
          </>
        ) : null}
      </main>
    </div>
  )
}

function TabTrigger({
  value,
  children,
}: {
  value: string
  children: React.ReactNode
}) {
  return (
    <Tabs.Trigger
      value={value}
      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl text-sm font-semibold text-muted transition data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-sm"
    >
      {children}
    </Tabs.Trigger>
  )
}

function Fact({
  label,
  value,
  warn,
}: {
  label: string
  value: React.ReactNode
  warn?: boolean
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold tracking-wider text-faint uppercase">
        {label}
      </dt>
      <dd className={cx('mt-0.5 truncate font-medium', warn && 'text-warn')}>
        {value}
      </dd>
    </div>
  )
}

function podHealth(pod: PodSummary) {
  if (pod.terminating) return 'idle' as const
  if (pod.ready) return 'healthy' as const
  const broken = [...pod.containers, ...pod.initContainers].some(
    (c) =>
      c.state === 'waiting' &&
      c.reason &&
      !/ContainerCreating|PodInitializing/.test(c.reason),
  )
  if (broken || pod.phase === 'Failed') return 'failing' as const
  return 'progressing' as const
}

function PodCard({
  pod,
  namespace,
  now,
  readOnly,
  onLogs,
  onDeleted,
}: {
  pod: PodSummary
  namespace: string
  now: number
  readOnly: boolean
  onLogs: () => void
  onDeleted: () => void
}) {
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const status = pod.terminating ? 'Terminating' : pod.phase
  return (
    <Card className="fade-up overflow-hidden">
      <div className="flex items-start gap-3 p-4 pb-3">
        <StatusDot health={podHealth(pod)} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[13px] font-semibold">
            {pod.name}
          </p>
          <p className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs text-muted">
            <span>{status}</span>
            <span>{age(pod.createdAt, now)}</span>
            {pod.restarts ? (
              <span className="inline-flex items-center gap-0.5 text-warn">
                <RotateCcw className="size-3" /> {pod.restarts}
              </span>
            ) : null}
            {pod.node ? <span className="truncate">{pod.node}</span> : null}
            {pod.ip ? <span className="font-mono">{pod.ip}</span> : null}
          </p>
          {pod.usage ? (
            <div className="mt-3 grid grid-cols-2 gap-4">
              <PodResource
                label="CPU"
                used={pod.usage.cpu}
                limit={pod.limits.cpu}
                request={pod.requests.cpu}
                format={formatCpu}
              />
              <PodResource
                label="Memory"
                used={pod.usage.memory}
                limit={pod.limits.memory}
                request={pod.requests.memory}
                format={formatBytes}
              />
            </div>
          ) : null}
        </div>
        <ActionMenu
          trigger={
            <IconButton
              label={`Actions for ${pod.name}`}
              className="-mt-2 -mr-2"
            >
              <MoreVertical className="size-5" />
            </IconButton>
          }
        >
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className={menuClass}
            >
              <DropdownMenu.Item className={itemClass} onSelect={onLogs}>
                <ScrollText className="size-4" /> View logs
              </DropdownMenu.Item>
              {!readOnly ? (
                <DropdownMenu.Item
                  className={cx(itemClass, 'text-bad')}
                  onSelect={() => setConfirming(true)}
                >
                  <Trash2 className="size-4" /> Delete pod…
                </DropdownMenu.Item>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </ActionMenu>
      </div>
      <div className="divide-y divide-line border-t border-line bg-surface-2/40">
        {pod.initContainers
          .filter((c) => c.state !== 'terminated' || c.reason !== 'Completed')
          .map((c) => (
            <ContainerRow key={c.name} c={c} init now={now} />
          ))}
        {pod.containers.map((c) => (
          <ContainerRow key={c.name} c={c} now={now} />
        ))}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete pod?"
        danger
        description={
          <>
            <span className="font-mono text-fg">{pod.name}</span> will be
            terminated and its controller will schedule a replacement.
          </>
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          try {
            await api.deletePod(namespace, pod.name)
            toast('ok', `Deleting ${pod.name}`)
            onDeleted()
          } catch (err) {
            toast('error', `Delete failed: ${(err as Error).message}`)
          }
        }}
      />
    </Card>
  )
}

function ContainerRow({
  c,
  init,
  now,
}: {
  c: ContainerSummary
  init?: boolean
  now: number
}) {
  const tone =
    c.state === 'running' && c.ready
      ? 'text-ok'
      : c.state === 'running'
        ? 'text-info'
        : c.state === 'waiting' &&
            c.reason &&
            !/ContainerCreating|PodInitializing/.test(c.reason)
          ? 'text-bad'
          : 'text-muted'
  return (
    <div className="px-4 py-2.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="truncate font-medium">{c.name}</span>
        {init ? (
          <span className="rounded bg-surface-2 px-1 text-[10px] text-muted">
            init
          </span>
        ) : null}
        <span className={cx('ml-auto shrink-0 font-semibold', tone)}>
          {c.reason ?? c.state}
          {c.state === 'running' && c.startedAt
            ? ` · ${age(c.startedAt, now)}`
            : ''}
        </span>
      </div>
      {c.message ? (
        <p className="mt-1 line-clamp-3 break-words text-bad">{c.message}</p>
      ) : null}
      {c.lastTermination ? (
        <p className="mt-1 text-faint">Last exit: {c.lastTermination}</p>
      ) : null}
    </div>
  )
}

function Events({ events, now }: { events: EventSummary[]; now: number }) {
  if (!events.length)
    return (
      <p className="py-10 text-center text-sm text-muted">No recent events.</p>
    )
  return (
    <Card className="divide-y divide-line">
      {events.map((e, i) => (
        <div key={i} className="px-4 py-3 text-sm">
          <div className="flex items-center gap-2">
            <span
              className={cx(
                'font-semibold',
                e.type === 'Warning' ? 'text-warn' : 'text-fg',
              )}
            >
              {e.reason}
            </span>
            {e.count > 1 ? (
              <span className="text-xs text-faint">×{e.count}</span>
            ) : null}
            <span className="ml-auto shrink-0 text-xs text-faint">
              {age(e.lastSeen, now)}
            </span>
          </div>
          <p className="mt-0.5 text-muted break-words">{e.message}</p>
          <p className="mt-1 truncate font-mono text-[11px] text-faint">
            {e.object}
          </p>
        </div>
      ))}
    </Card>
  )
}

const RANGES: HistoryRange[] = ['1h', '6h', '24h', '7d']

function UsageCard({
  workload: w,
  history,
}: {
  workload: Workload
  history: boolean
}) {
  const [range, setRange] = useStored<HistoryRange>(
    'kubedash.usage.range',
    '6h',
  )
  const { data, loading, error } = usePoll(
    () => (history ? api.history(w, range) : Promise.resolve(null)),
    60_000,
    `${workloadKey(w)}/${range}/${history}`,
  )
  // Limits are per pod; the charts show the sum over all replicas.
  const replicas = Math.max(w.desired, 1)
  const memoryLimit =
    w.podLimits.memory != null ? w.podLimits.memory * replicas : null
  const cpuLimit = w.podLimits.cpu != null ? w.podLimits.cpu * replicas : null

  return (
    <Card className="fade-up mt-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold">Usage</h2>
        {history ? (
          <div
            role="radiogroup"
            aria-label="Time range"
            className="flex rounded-xl bg-surface-2 p-0.5"
          >
            {RANGES.map((r) => (
              <button
                key={r}
                role="radio"
                aria-checked={range === r}
                onClick={() => setRange(r)}
                className={cx(
                  'h-7 rounded-[10px] px-2.5 text-xs font-semibold transition',
                  range === r ? 'bg-surface text-fg shadow-sm' : 'text-muted',
                )}
              >
                {r}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {history ? (
        <div className="mt-3 grid grid-cols-2 gap-4">
          <UsageChart
            title="CPU"
            points={data?.cpu ?? []}
            format={formatCpu}
            limit={cpuLimit}
            rangeLabel={range}
            loading={loading}
          />
          <UsageChart
            title="Memory"
            points={data?.memory ?? []}
            format={formatBytes}
            limit={memoryLimit}
            rangeLabel={range}
            loading={loading}
          />
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-4">
          <PodResource
            label="CPU"
            used={w.usage?.cpu ?? 0}
            limit={cpuLimit}
            request={null}
            format={formatCpu}
          />
          <PodResource
            label="Memory"
            used={w.usage?.memory ?? 0}
            limit={memoryLimit}
            request={null}
            format={formatBytes}
          />
        </div>
      )}
      {error ? (
        <p className="mt-2 text-xs text-bad">
          History unavailable: {error.message}
        </p>
      ) : null}
    </Card>
  )
}

function PodResource({
  label,
  used,
  limit,
  request,
  format,
}: {
  label: string
  used: number
  limit: number | null
  request: number | null
  format: (v: number) => string
}) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold tracking-wider text-faint uppercase">
        {label}
      </p>
      <p className="truncate font-mono text-xs tabular-nums">
        {format(used)}
        <span className="text-faint">
          {limit != null ? ` / ${format(limit)}` : ' · no limit'}
        </span>
      </p>
      <div className="mt-1.5">
        <Meter value={used} max={limit} label={`${label} usage`} />
      </div>
      {limit == null && request != null ? (
        <p className="mt-1 text-[10.5px] text-faint">
          request {format(request)}
        </p>
      ) : null}
    </div>
  )
}
