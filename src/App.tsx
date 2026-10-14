import { useCallback } from 'react'
import { Dashboard } from './components/Dashboard'
import { ToastProvider } from './components/ui'
import { WorkloadDetail } from './components/WorkloadDetail'
import { api, type Config } from './lib/api'
import { usePath, usePoll, useStored } from './lib/hooks'

const WORKLOAD_ROUTE =
  /^\/(deployment|statefulset|daemonset)\/([^/]+)\/([^/]+)\/?$/

export function App() {
  const path = usePath()
  const [pinned, setPinned] = useStored<string[]>('kubedash.pinned', [])
  const togglePin = useCallback(
    (key: string) =>
      setPinned((current) =>
        current.includes(key)
          ? current.filter((k) => k !== key)
          : [...current, key],
      ),
    [setPinned],
  )
  const config = usePoll<Config>(api.config, 300_000, 'config')
  const readOnly = config.data?.readOnly ?? true
  const route = WORKLOAD_ROUTE.exec(path)
  // Keep the overview polling while a detail page is open so "back" is instant and fresh.
  const overview = usePoll(api.overview, route ? 15_000 : 5000, 'overview')

  return (
    <ToastProvider>
      {route ? (
        <WorkloadDetail
          key={path}
          kind={route[1]}
          namespace={decodeURIComponent(route[2])}
          name={decodeURIComponent(route[3])}
          readOnly={readOnly}
          pinned={pinned}
          togglePin={togglePin}
        />
      ) : (
        <Dashboard
          overview={overview.data}
          error={overview.error}
          loading={overview.loading}
          refresh={overview.refresh}
          readOnly={readOnly}
          pinned={pinned}
          togglePin={togglePin}
        />
      )}
    </ToastProvider>
  )
}
