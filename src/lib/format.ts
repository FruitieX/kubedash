import type { FluxObject, FluxRef, Health, Workload } from './api'

/** Compact relative age like kubectl: 42s, 5m, 3h, 12d. */
export function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '–'
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  if (Number.isNaN(seconds)) return '–'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 365) return `${days}d`
  return `${Math.floor(days / 365)}y`
}

/** `ghcr.io/org/app:main@sha256:abcdef…` → `{ name: 'app', tag: 'main@abcdef1' }` */
export function shortImage(image: string): { name: string; tag: string } {
  const [ref, digest] = image.split('@')
  const lastSlash = ref.lastIndexOf('/')
  const tail = ref.slice(lastSlash + 1)
  const colon = tail.lastIndexOf(':')
  const name = colon >= 0 ? tail.slice(0, colon) : tail
  let tag = colon >= 0 ? tail.slice(colon + 1) : digest ? '' : 'latest'
  if (/^[0-9a-f]{40}$/.test(tag)) tag = tag.slice(0, 7)
  if (digest) {
    const short = digest.replace(/^sha256:/, '').slice(0, 7)
    tag = tag ? `${tag}@${short}` : `@${short}`
  }
  return { name, tag }
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | null

const LEVELS: [LogLevel, RegExp][] = [
  ['error', /\b(error|err|fatal|panic|critical|crit)\b|level=(error|fatal)/i],
  ['warn', /\b(warn|warning)\b|level=warn/i],
  ['debug', /\b(debug|trace)\b|level=(debug|trace)/i],
  ['info', /\b(info)\b|level=info/i],
]

export function logLevel(line: string): LogLevel {
  // Only inspect the head of the line; message bodies often mention "error".
  const head = line.slice(0, 120)
  for (const [level, pattern] of LEVELS) if (pattern.test(head)) return level
  return null
}

/** Splits the RFC3339 timestamp the API prefixes onto each log line. */
export function splitTimestamp(line: string): {
  ts: string | null
  text: string
} {
  const match = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/s.exec(line)
  return match ? { ts: match[1], text: match[2] } : { ts: null, text: line }
}

export const HEALTH_ORDER: Health[] = [
  'failing',
  'degraded',
  'progressing',
  'healthy',
  'idle',
]

export const HEALTH_LABEL: Record<Health, string> = {
  healthy: 'Healthy',
  progressing: 'Rolling out',
  degraded: 'Degraded',
  failing: 'Failing',
  idle: 'Scaled to zero',
}

export const KIND_LABEL: Record<Workload['kind'], string> = {
  deployment: 'Deployment',
  statefulset: 'StatefulSet',
  daemonset: 'DaemonSet',
}

export const workloadKey = (w: Pick<Workload, 'kind' | 'namespace' | 'name'>) =>
  `${w.kind}/${w.namespace}/${w.name}`

export const fluxKey = (f: FluxRef) => `${f.kind}/${f.namespace}/${f.name}`

export function fluxFailed(f: FluxObject | undefined | null) {
  return f?.state === 'failed'
}

/** A workload needs attention when it is unhealthy or its Flux owner failed to apply. */
export function hasIssue(w: Workload, flux?: Map<string, FluxObject>) {
  if (
    w.health === 'failing' ||
    w.health === 'degraded' ||
    w.health === 'progressing'
  )
    return true
  return Boolean(w.flux && flux && fluxFailed(flux.get(fluxKey(w.flux))))
}

/** Cores → `25m`, `1.25`. */
export function formatCpu(cores: number | null | undefined): string {
  if (cores == null) return '–'
  if (cores < 1)
    return `${Math.max(Math.round(cores * 1000), cores > 0 ? 1 : 0)}m`
  return cores < 10
    ? String(Number(cores.toFixed(2)))
    : String(Number(cores.toFixed(1)))
}

/** Bytes → `117Mi`, `1.4Gi`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '–'
  const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = value < 10 && unit > 0 ? 1 : 0
  return `${Number(value.toFixed(digits))}${units[unit]}`
}

/** `main@sha1:2c4c2cda98…` → `main@2c4c2cd`; chart versions pass through. */
export function shortRevision(
  revision: string | null | undefined,
): string | null {
  if (!revision) return null
  const match = /^(?:(.*)@)?sha1:([0-9a-f]{7})[0-9a-f]*$/.exec(revision)
  if (match) return match[1] ? `${match[1]}@${match[2]}` : match[2]
  return revision
}
