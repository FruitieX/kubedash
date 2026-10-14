import { Server } from 'lucide-react'
import type { NodeSummary } from '../lib/api'
import { formatBytes, formatCpu } from '../lib/format'
import { Card, cx, Meter, Sheet } from './ui'

export function NodesSheet({
  open,
  onOpenChange,
  nodes,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  nodes: NodeSummary[]
}) {
  const ready = nodes.filter((n) => n.ready).length
  const sorted = [...nodes].sort(
    (a, b) => Number(a.ready) - Number(b.ready) || a.name.localeCompare(b.name),
  )
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Nodes"
      description={`${ready} of ${nodes.length} ready`}
    >
      <div className="space-y-3 pb-4">
        {sorted.map((n) => (
          <Card key={n.name} className="p-4">
            <div className="flex items-center gap-2.5">
              <Server
                className={cx('size-4', n.ready ? 'text-ok' : 'text-bad')}
              />
              <span className="truncate font-mono text-sm font-semibold">
                {n.name}
              </span>
              <span className="ml-auto shrink-0 text-xs text-muted">
                {n.roles.length ? n.roles.join(', ') : 'worker'}
              </span>
            </div>
            {!n.ready ? (
              <p className="mt-1 text-xs font-semibold text-bad">Not ready</p>
            ) : null}
            <div className="mt-3 grid grid-cols-2 gap-4">
              <Resource
                label="CPU"
                used={n.usage?.cpu}
                total={n.cpu}
                format={formatCpu}
              />
              <Resource
                label="Memory"
                used={n.usage?.memory}
                total={n.memory}
                format={formatBytes}
              />
            </div>
            {n.version ? (
              <p className="mt-2.5 text-[11px] text-faint">
                kubelet {n.version}
              </p>
            ) : null}
          </Card>
        ))}
      </div>
    </Sheet>
  )
}

function Resource({
  label,
  used,
  total,
  format,
}: {
  label: string
  used: number | undefined
  total: number | null
  format: (v: number) => string
}) {
  const pct = used != null && total ? Math.round((used / total) * 100) : null
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-faint uppercase">
          {label}
        </span>
        <span className="text-sm font-semibold tabular-nums">
          {pct != null ? `${pct}%` : '–'}
        </span>
      </div>
      <div className="mt-1.5">
        <Meter
          value={used ?? 0}
          max={used != null ? total : null}
          label={`${label} usage`}
        />
      </div>
      <p className="mt-1 truncate text-[11px] text-muted tabular-nums">
        {used != null ? format(used) : '–'} /{' '}
        {total != null ? format(total) : '–'}
      </p>
    </div>
  )
}
