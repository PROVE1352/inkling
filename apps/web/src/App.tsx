import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { AppLayout } from './components/AppLayout'
import { RequireAuth } from './components/RequireAuth'
import { FullScreenSpinner, Spinner } from './components/Spinner'
import { Home } from './pages/Home'
import { Login } from './pages/Login'
import { reloadOnceForStaleChunk } from './lib/pwa'

// Route-level code splitting (docs/adr/0704-route-and-feature-code-splitting.md).
// The entry chunk holds the shell (router, React Query, AppLayout/sidebar) and the login page;
// every other page — including the BlockNote editor behind PageView — is its own chunk.
function lazyNamed<K extends string>(
  load: () => Promise<Record<K, ComponentType<object>>>,
  name: K,
) {
  return lazy(() =>
    load().then(
      (m) => ({ default: m[name] }),
      // chunk of a previous deploy gone → reload once (lib/pwa.ts)
      (err: unknown) => reloadOnceForStaleChunk(err),
    ),
  )
}

const loadPageView = () => import('./pages/PageView')
const PageView = lazyNamed(loadPageView, 'PageView')
const Admin = lazyNamed(() => import('./pages/Admin'), 'Admin')
const DueView = lazyNamed(() => import('./pages/DueView'), 'DueView')
const GlobalCalendar = lazyNamed(() => import('./pages/GlobalCalendar'), 'GlobalCalendar')
const GraphView = lazyNamed(() => import('./pages/GraphView'), 'GraphView')
const JoinWorkspace = lazyNamed(() => import('./pages/JoinWorkspace'), 'JoinWorkspace')
const OAuthAuthorize = lazyNamed(() => import('./pages/OAuthAuthorize'), 'OAuthAuthorize')
const Connections = lazyNamed(() => import('./pages/Connections'), 'Connections')
const Register = lazyNamed(() => import('./pages/Register'), 'Register')
const ResetPassword = lazyNamed(() => import('./pages/ResetPassword'), 'ResetPassword')
const VerifyEmail = lazyNamed(() => import('./pages/VerifyEmail'), 'VerifyEmail')
const Settings = lazyNamed(() => import('./pages/Settings'), 'Settings')
const PublicView = lazyNamed(() => import('./pages/PublicView'), 'PublicView')
const TagsView = lazyNamed(() => import('./pages/TagsView'), 'TagsView')
const SharedView = lazyNamed(() => import('./pages/SharedView'), 'SharedView')
const WorkspaceHome = lazyNamed(() => import('./pages/WorkspaceHome'), 'WorkspaceHome')

/** Full-screen fallback for top-level routes. */
function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<FullScreenSpinner />}>{children}</Suspense>
}

/** In-layout fallback: the sidebar stays put while the page chunk loads. */
function Pane({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full w-full items-center justify-center">
          <Spinner size={24} />
        </div>
      }
    >
      {children}
    </Suspense>
  )
}

// Once the shell is up, fetch the editor chunk in the background — it is the next screen for
// almost every session (the service worker precaches it too, this covers the first visit).
function usePrefetchEditor() {
  useEffect(() => {
    const ric =
      (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500))
    ric(() => {
      void loadPageView().catch(() => {})
    })
  }, [])
}

export function App() {
  usePrefetchEditor()
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Page><Register /></Page>} />
      <Route path="/signup" element={<Page><Register /></Page>} />
      <Route path="/reset" element={<Page><ResetPassword /></Page>} />
      <Route path="/verify" element={<Page><VerifyEmail /></Page>} />
      <Route path="/join/:code" element={<Page><JoinWorkspace /></Page>} />
      {/* Public read-only viewer — outside RequireAuth/AppLayout (no sign-in needed) */}
      <Route path="/s/:token" element={<Page><PublicView /></Page>} />
      <Route path="/s/:token/p/:ref" element={<Page><PublicView /></Page>} />
      {/* MCP connector OAuth consent screen — redirects to /login?next= itself when signed out */}
      <Route path="/oauth/authorize" element={<Page><OAuthAuthorize /></Page>} />
      <Route
        path="/settings/connections"
        element={
          <RequireAuth>
            <Page>
              <Connections />
            </Page>
          </RequireAuth>
        }
      />
      <Route path="/" element={<Home />} />
      <Route
        path="/w/:wsId"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<Pane><WorkspaceHome /></Pane>} />
        <Route path="admin" element={<Pane><Admin /></Pane>} />
        <Route path="calendar" element={<Pane><GlobalCalendar /></Pane>} />
        <Route path="due" element={<Pane><DueView /></Pane>} />
        <Route path="graph" element={<Pane><GraphView /></Pane>} />
        <Route path="settings" element={<Pane><Settings /></Pane>} />
        <Route path="shared" element={<Pane><SharedView /></Pane>} />
        <Route path="tags" element={<Pane><TagsView /></Pane>} />
        <Route path="tags/:tag" element={<Pane><TagsView /></Pane>} />
        <Route path="p/:pageId" element={<Pane><PageView /></Pane>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
