import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useMe } from '../api'
import { syncPush } from '../lib/push'

// Web push housekeeping while signed in (docs/adr/2220-*): re-sends this browser's subscription when
// this account turned push on here before (new session, new server key; never asks for permission),
// and routes the app when a notification click asks an open window to show a page (push-sw.js).
export function PushSync() {
  const me = useMe()
  const navigate = useNavigate()
  const userId = me.data?.id

  useEffect(() => {
    if (!userId) return
    void syncPush(userId).catch(() => undefined)
  }, [userId])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; url?: unknown } | null
      if (!d || d.type !== 'inkling:open' || typeof d.url !== 'string') return
      // same-origin paths only (the worker checks too)
      if (!d.url.startsWith('/') || d.url.startsWith('//')) return
      navigate(d.url)
      e.ports[0]?.postMessage('ok')
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [navigate])

  return null
}
