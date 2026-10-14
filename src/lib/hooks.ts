import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

/** Fetches on an interval while the tab is visible; refetches when it becomes visible again. */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  key: string,
) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const current = generation.current
    try {
      const result = await fetcherRef.current()
      if (current !== generation.current) return
      setData(result)
      setError(null)
      setUpdatedAt(Date.now())
    } catch (err) {
      if (current !== generation.current) return
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }, [])

  // A new key means a different resource: drop stale data and fetch immediately.
  useEffect(() => {
    generation.current += 1
    setData(null)
    setError(null)
    setLoading(true)
    void refresh()
  }, [key, refresh])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, intervalMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [intervalMs, refresh])

  return { data, error, loading, updatedAt, refresh }
}

/** Re-renders every `ms` so relative timestamps stay fresh. */
export function useNow(ms = 10_000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(timer)
  }, [ms])
  return now
}

const subscribers = new Set<() => void>()
function notify() {
  subscribers.forEach((fn) => fn())
}
window.addEventListener('popstate', notify)

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  if (path === window.location.pathname) return
  const state = { fromApp: true }
  if (opts.replace) window.history.replaceState(state, '', path)
  else window.history.pushState(state, '', path)
  notify()
  window.scrollTo({ top: 0 })
}

/** Back if we navigated here inside the app, otherwise go home (e.g. opened via deep link). */
export function goBack() {
  if (window.history.state?.fromApp) window.history.back()
  else navigate('/', { replace: true })
}

export function usePath() {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    () => window.location.pathname,
  )
}

/** JSON value persisted in localStorage (best effort). */
export function useStored<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage unavailable (private mode); keep in memory only.
    }
  }, [key, value])
  return [value, setValue] as const
}
