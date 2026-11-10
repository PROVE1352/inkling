import { useCallback, useEffect, useState } from 'react'
import { PUSH_KIND_GROUPS, type PushDeviceDTO, type PushKindGroup } from '@inkling/shared'
import { ApiError, useMe } from '../api'
import { fmtRelative, useT } from '../i18n'
import { deviceState, disablePush, enablePush, type PushDeviceState } from '../lib/push'
import { useQueryClient } from '@tanstack/react-query'
import { qkPush, usePushSettings, useRemovePushDevice, useTestPush, useUpdatePushSettings } from '../pushApi'
import { Group, Row, SettingsFlat, Toggle, useSettingsFlat } from './SettingsRows'
import { Spinner } from './Spinner'

// Settings → Notifications → Push notifications (docs/adr/2220-* .. 2223-*). Permission is asked only
// when the person clicks "Turn on" here; nothing on the first screen asks for it.

const STATE_KEY: Record<PushDeviceState, Parameters<ReturnType<typeof useT>>[0]> = {
  unsupported: 'push.state.unsupported',
  'ios-home': 'push.state.iosHome',
  'no-worker': 'push.state.noWorker',
  'server-off': 'push.state.serverOff',
  denied: 'push.state.denied',
  off: 'push.state.off',
  on: 'push.state.on',
}

const KIND_KEY: Record<PushKindGroup, Parameters<ReturnType<typeof useT>>[0]> = {
  mention: 'push.kind.mention',
  assigned: 'push.kind.assigned',
  reply: 'push.kind.reply',
  comment: 'push.kind.comment',
  approval: 'push.kind.approval',
  reminder: 'push.kind.reminder',
  updates: 'push.kind.updates',
}

export function PushSettings() {
  // On the Notifications page the section titles are left out (the page has one); this section is
  // the second one there, so it keeps its own.
  const flat = useSettingsFlat()
  return flat ? (
    <SettingsFlat omitTitle="">
      <PushSection />
    </SettingsFlat>
  ) : (
    <PushSection />
  )
}

function PushSection() {
  const t = useT()
  const me = useMe()
  const qc = useQueryClient()
  const settings = usePushSettings()
  const update = useUpdatePushSettings()
  const test = useTestPush()
  const [state, setState] = useState<PushDeviceState | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)

  const refresh = useCallback(async () => {
    const s = await deviceState().catch(() => ({ state: 'unsupported' as const, endpoint: null }))
    // "on" in the browser but the server does not list this session's row: it still needs registering
    setState(s.state)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onError = (err: unknown, fallback: Parameters<typeof t>[0]) =>
    setMsg({ text: err instanceof ApiError ? err.message : t(fallback), error: true })

  const turnOn = async () => {
    if (!me.data) return
    setBusy(true)
    setMsg(null)
    try {
      setState(await enablePush(me.data.id))
    } catch (err) {
      onError(err, 'push.enableFailed')
      await refresh()
    } finally {
      setBusy(false)
      void qc.invalidateQueries({ queryKey: qkPush.settings })
    }
  }

  const turnOff = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await disablePush()
    } finally {
      setBusy(false)
      await refresh()
      void qc.invalidateQueries({ queryKey: qkPush.settings })
    }
  }

  const sendTest = (deviceId?: string) => {
    setMsg(null)
    test.mutate(deviceId, {
      onSuccess: () => setMsg({ text: t('push.testSent'), error: false }),
      onError: (err) => onError(err, 'push.testFailed'),
    })
  }

  const data = settings.data
  const kinds = new Set(data?.kinds ?? [])
  const toggleKind = (k: PushKindGroup, on: boolean) => {
    const next = PUSH_KIND_GROUPS.filter((x) => (x === k ? on : kinds.has(x)))
    update.mutate({ kinds: next })
  }
  const current = data?.devices.find((d) => d.current)
  const deviceOn = state === 'on' && !!current

  return (
    <Group title={t('push.title')} desc={t('push.desc')}>
      <Row
        id="pushDevice"
        title={t('push.thisDevice')}
        desc={
          <span data-testid="push-state" data-state={state ?? 'loading'}>
            {state ? t(STATE_KEY[state === 'on' && data && !current ? 'off' : state]) : '…'}
          </span>
        }
      >
        {busy || state === null ? (
          <Spinner size={16} />
        ) : deviceOn ? (
          <button
            type="button"
            data-testid="push-disable"
            onClick={() => void turnOff()}
            className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover"
          >
            {t('push.disable')}
          </button>
        ) : state === 'off' || state === 'on' ? (
          <button
            type="button"
            data-testid="push-enable"
            onClick={() => void turnOn()}
            disabled={!me.data}
            className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
          >
            {t('push.enable')}
          </button>
        ) : null}
      </Row>

      {settings.isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner size={16} />
        </div>
      ) : !data ? (
        <p className="px-4 py-3 text-xs text-red-600">{t('push.loadFailed')}</p>
      ) : data.available ? (
        <>
          <Row id="pushEnabled" title={t('push.enabled')} desc={t('push.enabledDesc')}>
            <Toggle label={t('push.enabled')} checked={data.enabled} onChange={(v) => update.mutate({ enabled: v })} />
          </Row>
          <div className="px-4 py-3" data-pref="pushKinds">
            <div className="text-sm text-ink">{t('push.kinds')}</div>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {PUSH_KIND_GROUPS.map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    className="accent-[var(--color-accent)]"
                    checked={kinds.has(k)}
                    disabled={!data.enabled}
                    onChange={(e) => toggleKind(k, e.target.checked)}
                  />
                  {t(KIND_KEY[k])}
                </label>
              ))}
            </div>
          </div>
          <Row id="pushHideContent" title={t('push.hideContent')} desc={t('push.hideContentDesc')}>
            <Toggle label={t('push.hideContent')} checked={data.hideContent} onChange={(v) => update.mutate({ hideContent: v })} />
          </Row>
          <div className="px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex-1 text-sm text-ink">{t('push.devices')}</div>
              {data.devices.length > 0 && (
                <button
                  type="button"
                  data-testid="push-test"
                  onClick={() => sendTest()}
                  disabled={test.isPending}
                  className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-50"
                >
                  {t('push.test')}
                </button>
              )}
            </div>
            {data.devices.length === 0 ? (
              <p className="mt-2 text-xs text-sub">{t('push.noDevices')}</p>
            ) : (
              <ul className="mt-2 divide-y divide-line rounded-md border border-line" data-testid="push-devices">
                {data.devices.map((d) => (
                  <DeviceRow
                    key={d.id}
                    device={d}
                    // removing this browser's own row also drops its subscription, so the app does not re-register it
                    onRemoved={() => void (d.current ? disablePush() : Promise.resolve()).finally(() => void refresh())}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
      {msg && <p className={`px-4 py-2 text-xs ${msg.error ? 'text-red-600' : 'text-sub'}`}>{msg.text}</p>}
    </Group>
  )
}

function DeviceRow({ device, onRemoved }: { device: PushDeviceDTO; onRemoved: () => void }) {
  const t = useT()
  const remove = useRemovePushDevice()
  const details = [
    device.current ? t('push.current') : null,
    device.stale ? t('push.stale') : null,
    device.failureCount > 0 ? t('push.failing', { count: device.failureCount }) : null,
    device.lastSuccessAt ? t('push.lastSent', { when: fmtRelative(device.lastSuccessAt) }) : null,
  ].filter(Boolean)
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink">{device.label || t('push.unknownDevice')}</div>
        {details.length > 0 && <div className="truncate text-xs text-sub">{details.join(' · ')}</div>}
      </div>
      <button
        type="button"
        onClick={() => remove.mutate(device.id, { onSuccess: onRemoved })}
        disabled={remove.isPending}
        className="rounded-md border border-line px-2 py-1 text-xs text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-40"
      >
        {t('push.remove')}
      </button>
    </li>
  )
}
