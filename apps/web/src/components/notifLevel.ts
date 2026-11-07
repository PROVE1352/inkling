import { NOTIFICATION_LEVELS, type NotificationLevel } from '@inkling/shared'
import { t, type TKey } from '../i18n'

// Labels and one-line explanations of the four notification levels (docs/adr/1001-*).

const LABEL: Record<NotificationLevel, TKey> = {
  all: 'notifLevel.all',
  mentions: 'notifLevel.mentions',
  nothing: 'notifLevel.nothing',
  mute: 'notifLevel.mute',
}

const DESC: Record<NotificationLevel, TKey> = {
  all: 'notifLevel.allDesc',
  mentions: 'notifLevel.mentionsDesc',
  nothing: 'notifLevel.nothingDesc',
  mute: 'notifLevel.muteDesc',
}

export function levelLabel(level: NotificationLevel): string {
  return t(LABEL[level])
}

export function levelDesc(level: NotificationLevel): string {
  return t(DESC[level])
}

export function levelOptions(): { value: NotificationLevel; label: string }[] {
  return NOTIFICATION_LEVELS.map((l) => ({ value: l, label: levelLabel(l) }))
}
