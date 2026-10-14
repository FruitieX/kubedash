import * as AlertDialog from '@radix-ui/react-alert-dialog'
import * as Dialog from '@radix-ui/react-dialog'
import { CheckCircle2, AlertTriangle, Loader2, X } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import type { Health } from '../lib/api'
import { HEALTH_LABEL } from '../lib/format'

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}

const HEALTH_COLOR: Record<Health, string> = {
  healthy: 'text-ok bg-ok',
  progressing: 'text-info bg-info',
  degraded: 'text-warn bg-warn',
  failing: 'text-bad bg-bad',
  idle: 'text-idle bg-idle',
}

export function StatusDot({
  health,
  className,
}: {
  health: Health
  className?: string
}) {
  const animate = health === 'progressing' || health === 'failing'
  return (
    <span
      aria-hidden
      className={cx(
        'inline-block size-2.5 shrink-0 rounded-full',
        HEALTH_COLOR[health],
        animate && 'pulse',
        className,
      )}
    />
  )
}

const BADGE_COLOR: Record<Health, string> = {
  healthy: 'bg-ok/12 text-ok',
  progressing: 'bg-info/12 text-info',
  degraded: 'bg-warn/14 text-warn',
  failing: 'bg-bad/12 text-bad',
  idle: 'bg-idle/15 text-muted',
}

export function HealthBadge({ health }: { health: Health }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        BADGE_COLOR[health],
      )}
    >
      <StatusDot health={health} className="size-1.5" />
      {HEALTH_LABEL[health]}
    </span>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  busy?: boolean
}

export function Button({
  variant = 'secondary',
  busy,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || busy}
      className={cx(
        'inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition select-none',
        'active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none',
        variant === 'primary' &&
          'bg-accent text-accent-fg shadow-sm shadow-accent/25 hover:brightness-110',
        variant === 'secondary' &&
          'border border-line bg-surface text-fg hover:bg-surface-2',
        variant === 'ghost' && 'text-muted hover:bg-surface-2 hover:text-fg',
        variant === 'danger' && 'bg-bad text-white hover:brightness-110',
        className,
      )}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : null}
      {children}
    </button>
  )
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-muted transition',
        'hover:bg-surface-2 hover:text-fg active:scale-95',
        'focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:outline-none',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function Card({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cx(
        'rounded-2xl border border-line bg-surface shadow-xs',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cx('animate-pulse rounded-lg bg-surface-2', className)} />
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay-in fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" />
        <AlertDialog.Content
          className={cx(
            'sheet-in fixed z-50 border border-line bg-surface p-5 shadow-2xl',
            'inset-x-3 bottom-3 rounded-3xl pb-safe',
            'sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:w-full sm:max-w-sm sm:-translate-x-1/2 sm:-translate-y-1/2 sm:pb-5',
          )}
        >
          <AlertDialog.Title className="text-lg font-semibold">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted">
            {description}
          </AlertDialog.Description>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <AlertDialog.Cancel asChild>
              <Button disabled={busy}>Cancel</Button>
            </AlertDialog.Cancel>
            <Button
              variant={danger ? 'danger' : 'primary'}
              busy={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await onConfirm()
                  onOpenChange(false)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

type Toast = { id: number; kind: 'ok' | 'error'; message: string }
const ToastContext = createContext<
  (kind: Toast['kind'], message: string) => void
>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id))
  }, [])
  const push = useCallback(
    (kind: Toast['kind'], message: string) => {
      const id = Date.now() + Math.random()
      setToasts((all) => [...all.slice(-2), { id, kind, message }])
      window.setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 3500)
    },
    [dismiss],
  )
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-3 pb-safe"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="fade-up pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-2xl border border-line bg-surface/95 p-3.5 text-sm shadow-xl backdrop-blur"
          >
            {t.kind === 'ok' ? (
              <CheckCircle2 className="mt-px size-5 shrink-0 text-ok" />
            ) : (
              <AlertTriangle className="mt-px size-5 shrink-0 text-bad" />
            )}
            <p className="min-w-0 flex-1 leading-snug break-words">
              {t.message}
            </p>
            <button
              aria-label="Dismiss"
              className="-m-1 rounded-lg p-1 text-faint hover:text-fg"
              onClick={() => dismiss(t.id)}
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/** Bottom sheet on phones, centered panel on larger screens. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay-in fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className={cx(
            'sheet-in fixed z-50 flex flex-col border border-line bg-bg shadow-2xl outline-none',
            'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-3xl',
            'sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-h-[80dvh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl',
          )}
        >
          <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" />
          <div className="flex shrink-0 items-start gap-3 px-5 pt-3 pb-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-lg font-semibold">
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-sm text-muted">
                  {description}
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">
                  {title}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <IconButton label="Close" className="-mt-1 -mr-2">
                <X className="size-5" />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-safe">
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Thin usage meter; turns amber past 80% and red past 95% of the maximum. */
export function Meter({
  value,
  max,
  label,
}: {
  value: number
  max: number | null
  label: string
}) {
  const fraction = max ? Math.min(1, value / max) : 0
  const tone =
    fraction > 0.95 ? 'bg-bad' : fraction > 0.8 ? 'bg-warn' : 'bg-accent'
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max ?? undefined}
      aria-valuenow={value}
      className="h-1.5 overflow-hidden rounded-full bg-surface-2"
    >
      {max ? (
        <div
          className={cx('h-full rounded-full transition-[width]', tone)}
          style={{ width: `${Math.max(fraction * 100, 2)}%` }}
        />
      ) : null}
    </div>
  )
}
