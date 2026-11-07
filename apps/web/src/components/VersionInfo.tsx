import { useQuery } from '@tanstack/react-query'
import { CLIENT_BUILD, CLIENT_VERSION } from '../lib/update'
import { useT } from '../i18n'

type VersionDTO = { version?: string; build?: string }

/** Settings › About: the version and build this tab is running, and the server's when they differ. */
export function VersionInfo() {
  const t = useT()
  const server = useQuery({
    queryKey: ['serverVersion'],
    queryFn: async (): Promise<VersionDTO | null> => {
      const r = await fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' })
      return r.ok ? ((await r.json()) as VersionDTO) : null
    },
    staleTime: 60_000,
  })
  const s = server.data
  const differs = !!s && ((s.version && s.version !== CLIENT_VERSION) || (s.build && s.build !== CLIENT_BUILD))
  return (
    <div className="text-xs leading-relaxed text-sub" data-testid="version-info">
      <p className="text-sm text-ink">{t('settings.version', { version: CLIENT_VERSION, build: CLIENT_BUILD })}</p>
      {differs && (
        <p className="mt-1">{t('settings.versionServer', { version: s?.version ?? '?', build: s?.build ?? '?' })}</p>
      )}
    </div>
  )
}
