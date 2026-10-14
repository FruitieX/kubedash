import {
  CheckCircle2,
  CircleSlash,
  GitBranch,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { useState } from 'react'
import {
  api,
  type FluxObject,
  type FluxSource,
  type FluxState,
} from '../lib/api'
import { age, fluxKey, shortRevision } from '../lib/format'
import { Button, Card, cx, IconButton, Sheet, useToast } from './ui'

const STATE: Record<
  FluxState,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  ready: {
    label: 'Applied',
    className: 'bg-ok/12 text-ok',
    icon: CheckCircle2,
  },
  reconciling: {
    label: 'Reconciling',
    className: 'bg-info/12 text-info',
    icon: Loader2,
  },
  failed: { label: 'Failed', className: 'bg-bad/12 text-bad', icon: XCircle },
  suspended: {
    label: 'Suspended',
    className: 'bg-idle/15 text-muted',
    icon: CircleSlash,
  },
  unknown: {
    label: 'Unknown',
    className: 'bg-idle/15 text-muted',
    icon: CircleSlash,
  },
}

export function FluxBadge({ state }: { state: FluxState }) {
  const { label, className, icon: Icon } = STATE[state]
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
        className,
      )}
    >
      <Icon
        className={cx('size-3.5', state === 'reconciling' && 'animate-spin')}
      />
      {label}
    </span>
  )
}

/** Requests a reconcile of the object and its source, like `flux reconcile --with-source`. */
export function useReconcile(onDone?: () => void) {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const reconcile = async (f: FluxObject) => {
    setBusy(fluxKey(f))
    try {
      await api.reconcile(f)
      toast('ok', `Reconcile requested for ${f.name}`)
      onDone?.()
    } catch (err) {
      toast('error', `Reconcile failed: ${(err as Error).message}`)
    } finally {
      // Keep the spinner briefly; Flux picks the request up within seconds.
      window.setTimeout(() => setBusy(null), 1500)
    }
  }
  return { busy, reconcile }
}

export function FluxCard({
  flux,
  now,
  readOnly,
  onReconciled,
}: {
  flux: FluxObject
  now: number
  readOnly: boolean
  onReconciled: () => void
}) {
  const { busy, reconcile } = useReconcile(onReconciled)
  const revision = shortRevision(flux.revision)
  return (
    <Card className="fade-up mt-3 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
          <GitBranch className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">Flux</span>
            <FluxBadge state={flux.state} />
          </div>
          <p className="mt-0.5 truncate text-xs text-muted">
            {flux.name} ·{' '}
            {flux.kind === 'HelmRelease' ? 'HelmRelease' : 'Kustomization'}
            {flux.namespace !== 'flux-system' ? ` · ${flux.namespace}` : ''}
          </p>
        </div>
        {!readOnly ? (
          <Button
            className="h-9 shrink-0 px-3"
            busy={busy === fluxKey(flux)}
            onClick={() => reconcile(flux)}
          >
            {busy === fluxKey(flux) ? null : <RefreshCw className="size-4" />}
            Reconcile
          </Button>
        ) : null}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div className="min-w-0">
          <dt className="text-[11px] font-semibold tracking-wider text-faint uppercase">
            Revision
          </dt>
          <dd className="mt-0.5 truncate font-mono text-xs font-medium">
            {revision ?? '–'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-semibold tracking-wider text-faint uppercase">
            Since
          </dt>
          <dd className="mt-0.5 truncate font-medium">
            {flux.since ? `${age(flux.since, now)} ago` : '–'}
          </dd>
        </div>
      </dl>
      {flux.state !== 'ready' && flux.message ? (
        <p
          className={cx(
            'mt-3 rounded-xl p-3 text-xs leading-relaxed break-words',
            flux.state === 'failed'
              ? 'bg-bad/8 text-bad'
              : 'bg-surface-2 text-muted',
          )}
        >
          {flux.reason ? (
            <span className="font-semibold">{flux.reason}: </span>
          ) : null}
          {flux.message}
        </p>
      ) : null}
    </Card>
  )
}

const ORDER: FluxState[] = [
  'failed',
  'reconciling',
  'suspended',
  'unknown',
  'ready',
]

export function FluxSheet({
  open,
  onOpenChange,
  flux,
  sources,
  now,
  readOnly,
  onReconciled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  flux: FluxObject[]
  sources: FluxSource[]
  now: number
  readOnly: boolean
  onReconciled: () => void
}) {
  const { busy, reconcile } = useReconcile(onReconciled)
  const sorted = [...flux].sort(
    (a, b) =>
      ORDER.indexOf(a.state) - ORDER.indexOf(b.state) ||
      a.name.localeCompare(b.name),
  )
  const ready = flux.filter((f) => f.state === 'ready').length
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Flux"
      description={`${ready} of ${flux.length} Kustomizations and HelmReleases applied`}
    >
      {sources.map((s) => (
        <Card key={`${s.namespace}/${s.name}`} className="mb-3 p-3.5">
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 text-faint" />
            <span className="truncate text-sm font-semibold">{s.name}</span>
            <span
              className={cx(
                'ml-auto text-xs font-semibold',
                s.ready ? 'text-ok' : 'text-bad',
              )}
            >
              {s.ready ? 'Fetched' : 'Not ready'}
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted">
            {shortRevision(s.revision) ?? '–'}
          </p>
          {s.url ? (
            <p className="truncate text-xs text-faint">{s.url}</p>
          ) : null}
          {!s.ready && s.message ? (
            <p className="mt-1 text-xs text-bad">{s.message}</p>
          ) : null}
        </Card>
      ))}
      <Card className="mb-4 divide-y divide-line">
        {sorted.map((f) => (
          <div key={fluxKey(f)} className="flex items-start gap-3 px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold">{f.name}</span>
                {f.state !== 'ready' ? <FluxBadge state={f.state} /> : null}
              </div>
              <p className="mt-0.5 truncate text-xs text-muted">
                {f.kind === 'HelmRelease' ? 'Helm' : 'Kustomization'}
                {f.namespace !== 'flux-system' ? ` · ${f.namespace}` : ''}
                {' · '}
                <span className="font-mono">
                  {shortRevision(f.revision) ?? '–'}
                </span>
                {' · '}
                {age(f.since, now)}
              </p>
              {f.state !== 'ready' && f.message ? (
                <p
                  className={cx(
                    'mt-1 line-clamp-3 text-xs break-words',
                    f.state === 'failed' ? 'text-bad' : 'text-muted',
                  )}
                >
                  {f.message}
                </p>
              ) : null}
            </div>
            {!readOnly ? (
              <IconButton
                label={`Reconcile ${f.name}`}
                className="-my-1 -mr-1.5"
                disabled={busy === fluxKey(f)}
                onClick={() => reconcile(f)}
              >
                <RefreshCw
                  className={cx(
                    'size-4',
                    busy === fluxKey(f) && 'animate-spin',
                  )}
                />
              </IconButton>
            ) : null}
          </div>
        ))}
      </Card>
    </Sheet>
  )
}
