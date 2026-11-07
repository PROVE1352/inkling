import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import 'pretendard/dist/web/variable/pretendardvariable.css'
import './index.css'
import { App } from './App'
import { ApiError } from './api'
import { initPwa } from './lib/pwa'
import { addUpdateSafetyCheck, noteServerBuild, setUpdateMode } from './lib/update'
import { UpdateBanner } from './components/UpdateBanner'
import { getLocale, setServerDefaultLocale, useLocale } from './i18n'

// Note: StrictMode is deliberately omitted. Its dev double-mount would destroy, in cleanup, the
// Y.Doc/HocuspocusProvider that CollabEditor creates in its useState initializer, breaking
// real-time collaboration.

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // A 4xx (client error) will not change on retry, so give up immediately.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false
        return failureCount < 1
      },
    },
  },
})

initPwa()

// Version check (docs/adr/0990-0993): the server's build id and UPDATE_MODE. Every later /api
// response is checked too (api.ts → noteServerBuild). Force mode never reloads while a mutation
// is in flight; an older server without /api/version means prompt mode.
addUpdateSafetyCheck(() => queryClient.isMutating() === 0)
fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' })
  .then((r) => {
    noteServerBuild(r.headers)
    return r.ok ? r.json() : null
  })
  .then((v: { updateMode?: unknown } | null) => setUpdateMode(v?.updateMode))
  .catch(() => setUpdateMode('prompt'))

// Language: the cached choice/default applies to the first paint; /auth/mode may then update the
// server default (DEFAULT_LOCALE) and /auth/me the user's saved choice (see i18n/index.ts).
document.documentElement.lang = getLocale()
fetch('/api/auth/mode', { credentials: 'same-origin' })
  .then((r) => (r.ok ? r.json() : null))
  .then((m: { defaultLocale?: unknown } | null) => {
    if (m) setServerDefaultLocale(m.defaultLocale)
  })
  .catch(() => {})

// Keyed on the locale: switching language remounts the app so every t() call re-runs
// (the query cache lives outside and survives).
function LocaleRoot() {
  const locale = useLocale()
  return (
    <>
      <App key={locale} />
      <UpdateBanner />
    </>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root element not found')

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <LocaleRoot />
    </BrowserRouter>
  </QueryClientProvider>,
)
