export type Kind = 'deployment' | 'statefulset' | 'daemonset'
export type Health = 'healthy' | 'progressing' | 'degraded' | 'failing' | 'idle'

export interface Workload {
  kind: Kind
  namespace: string
  name: string
  health: Health
  desired: number
  ready: number
  updated: number
  images: string[]
  createdAt: string | null
  restartedAt: string | null
  podRestarts: number
  runningSince: string | null
  problem: string | null
  urls: string[]
  flux: string | null
}

export interface NodeSummary {
  name: string
  ready: boolean
  roles: string[]
  version: string | null
  cpu: string | null
  memory: string | null
}

export interface Overview {
  workloads: Workload[]
  nodes: NodeSummary[]
}

export interface ContainerSummary {
  name: string
  image: string
  ready: boolean
  restarts: number
  state: 'running' | 'waiting' | 'terminated' | 'unknown'
  reason: string | null
  message: string | null
  startedAt: string | null
  lastTermination: string | null
}

export interface PodSummary {
  name: string
  phase: string
  ready: boolean
  terminating: boolean
  restarts: number
  node: string | null
  ip: string | null
  createdAt: string | null
  containers: ContainerSummary[]
  initContainers: ContainerSummary[]
}

export interface EventSummary {
  type: string
  reason: string
  message: string
  object: string
  count: number
  lastSeen: string | null
}

export interface WorkloadDetail {
  workload: Workload
  pods: PodSummary[]
  events: EventSummary[]
}

export interface Config {
  readOnly: boolean
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, init)
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // Non-JSON error body; keep the status line.
    }
    throw new ApiError(message, response.status)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const enc = encodeURIComponent

export const workloadPath = (
  w: Pick<Workload, 'kind' | 'namespace' | 'name'>,
) => `/${w.kind}/${enc(w.namespace)}/${enc(w.name)}`

/** Mutations carry a custom header that the server requires (CSRF protection). */
const mutation = (method: string): RequestInit => ({
  method,
  headers: { 'x-kubedash': '1' },
})

export const api = {
  config: () => request<Config>('/config'),
  overview: () => request<Overview>('/overview'),
  workload: (kind: string, namespace: string, name: string) =>
    request<WorkloadDetail>(
      `/workloads/${kind}/${enc(namespace)}/${enc(name)}`,
    ),
  restart: (w: Pick<Workload, 'kind' | 'namespace' | 'name'>) =>
    request<void>(`/workloads${workloadPath(w)}/restart`, mutation('POST')),
  deletePod: (namespace: string, name: string) =>
    request<void>(`/pods/${enc(namespace)}/${enc(name)}`, mutation('DELETE')),
  logsUrl: (
    namespace: string,
    pod: string,
    opts: {
      container?: string
      tail: number
      previous: boolean
      follow: boolean
    },
  ) => {
    const params = new URLSearchParams({
      tail: String(opts.tail),
      previous: String(opts.previous),
      follow: String(opts.follow),
    })
    if (opts.container) params.set('container', opts.container)
    return `/api/pods/${enc(namespace)}/${enc(pod)}/logs?${params}`
  },
}
