import { useT } from '../i18n'

// Avatars of connected users, from Yjs awareness.
export type CollabUser = {
  clientId: number
  name: string
  color: string
}

function initial(name: string): string {
  const trimmed = name.trim()
  return trimmed ? Array.from(trimmed)[0].toUpperCase() : '?'
}

export function OnlineUsers({ users }: { users: CollabUser[] }) {
  const t = useT()
  if (users.length === 0) return null

  const shown = users.slice(0, 5)
  const extra = users.length - shown.length

  return (
    <div className="flex items-center" aria-label={t('online.count', { count: users.length })}>
      {shown.map((u, i) => (
        <span
          key={u.clientId}
          title={u.name}
          className="flex h-6 w-6 select-none items-center justify-center rounded-full border-2 border-app text-[10px] font-semibold text-white"
          style={{
            backgroundColor: u.color,
            marginLeft: i === 0 ? 0 : -8,
            zIndex: shown.length - i,
          }}
        >
          {initial(u.name)}
        </span>
      ))}
      {extra > 0 && (
        <span
          className="flex h-6 w-6 select-none items-center justify-center rounded-full border-2 border-app bg-sub text-[10px] font-semibold text-white"
          style={{ marginLeft: -8, zIndex: 0 }}
          title={t('online.more', { count: extra })}
        >
          +{extra}
        </span>
      )}
    </div>
  )
}
