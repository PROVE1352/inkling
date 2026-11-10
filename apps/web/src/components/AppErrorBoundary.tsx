import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../i18n'

// Without a boundary, React 19 unmounts the whole root on an error it cannot hand to one: a render
// that throws, or a route chunk that failed to load after the one automatic reload
// (lib/pwa.ts reloadOnceForStaleChunk) left the tab completely white, with no way back but a reload
// the person had to think of (docs/adr/2324-*). Two boundaries: around the whole app (main.tsx) and
// around the page area (AppLayout), so a page that cannot be drawn keeps the sidebar and the next
// navigation tries again.

/** A failed dynamic import: the connection dropped, or the chunk is gone after a deploy. */
export function isChunkLoadError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError/i.test(
    text,
  )
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500)
  return String(err).slice(0, 500)
}

/** What the boundary shows instead of the screen that failed. `t` (not the hook): it may render outside LocaleRoot. */
export function CrashScreen({ error, inline = false }: { error: unknown; inline?: boolean }) {
  const chunk = isChunkLoadError(error)
  return (
    <div
      role="alert"
      data-testid="app-crash"
      className={`flex w-full items-center justify-center bg-app px-6 ${inline ? 'h-full py-10' : 'h-full min-h-dvh'}`}
    >
      <div className="max-w-md text-center">
        <p className="text-base font-medium text-ink">{t('crash.title')}</p>
        <p className="mt-2 text-sm text-sub">{t(chunk ? 'crash.chunk' : 'crash.body')}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-4 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          {t('crash.reload')}
        </button>
        <details className="mt-4 text-left text-xs text-sub">
          <summary className="cursor-pointer select-none text-center">{t('crash.details')}</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded border border-line p-2">{errorText(error)}</pre>
        </details>
      </div>
    </div>
  )
}

type Props = {
  children: ReactNode
  /** The page area's boundary: a smaller notice, and a new value (the route) clears the error. */
  inline?: boolean
  resetKey?: string
}
type State = { error: unknown; failed: boolean; key: string | undefined }

export class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null, failed: false, key: props.resetKey }
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error, failed: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey === state.key) return null
    // moved to another screen: draw it again
    return { key: props.resetKey, error: null, failed: false }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[inkling] a screen failed to render', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.failed) return <CrashScreen error={this.state.error} inline={this.props.inline} />
    return this.props.children
  }
}
