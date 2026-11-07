import { useT } from '../i18n'

// Shared spinner built on a rotating CSS border.
export function Spinner({
  size = 20,
  className = '',
}: {
  size?: number
  className?: string
}) {
  const t = useT()
  return (
    <span
      role="status"
      aria-label={t('common.loading')}
      className={`inline-block animate-spin rounded-full border-2 border-line border-t-accent ${className}`}
      style={{ width: size, height: size }}
    />
  )
}

// Full-screen loading state (RequireAuth, Home, etc.).
export function FullScreenSpinner() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-app">
      <Spinner size={28} />
    </div>
  )
}
