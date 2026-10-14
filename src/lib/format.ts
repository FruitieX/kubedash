import type { Health, Workload } from './api'

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

export function hasIssue(w: Workload) {
  return (
    w.health === 'failing' ||
    w.health === 'degraded' ||
    w.health === 'progressing'
  )
}
