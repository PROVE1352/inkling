import { t, type TKey } from '../i18n'

// All user-visible plugin UI strings in one place. Members are getters / functions over the i18n
// dictionary (i18n/<locale>/auth-admin.ts, 'plugins.*' keys) so every read follows the current language.

/** Builds a read-only map whose values are looked up on each access. */
function keyed(map: Record<string, TKey>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, key] of Object.entries(map)) Object.defineProperty(out, k, { get: () => t(key), enumerable: true })
  return out
}

export const PLUGIN_STRINGS = {
  // runtime
  stopped: (name: string, why: string) => t('plugins.stopped', { name, why }),
  killReason: keyed({
    flood: 'plugins.killFlood',
    oversize: 'plugins.killOversize',
    unresponsive: 'plugins.killUnresponsive',
    navigated: 'plugins.killNavigated',
    handshake: 'plugins.killHandshake',
    closed: 'plugins.killClosed',
  }),
  commandTimeout: (name: string) => t('plugins.commandTimeout', { name }),
  get tooManyFrames() { return t('plugins.tooManyFrames') },
  noticePrefix: (name: string) => t('plugins.noticePrefix', { name }),
  confirmWrite: (name: string, mode: 'replace' | 'append', here: boolean) =>
    t(
      mode === 'append'
        ? here ? 'plugins.confirmAppendHere' : 'plugins.confirmAppendOther'
        : here ? 'plugins.confirmReplaceHere' : 'plugins.confirmReplaceOther',
      { name },
    ),
  get confirmWriteLabel() { return t('oauth.allow') },
  get writeDenied() { return t('plugins.writeDenied') },
  get writeBusy() { return t('plugins.writeBusy') },
  get readOnlyBlock() { return t('plugins.readOnlyBlock') },

  // block placeholder
  get blockUnavailable() { return t('plugins.blockUnavailable') },
  blockUnavailableHint: (pluginId: string, blockType: string) =>
    t('plugins.blockUnavailableHint', { plugin: pluginId || '?', block: blockType || '?' }),
  get blockWaiting() { return t('plugins.blockWaiting') },
  get blockLoading() { return t('plugins.blockLoading') },
  get blockStopped() { return t('plugins.blockStopped') },
  get blockRestart() { return t('plugins.blockRestart') },

  // palette / slash menu
  paletteHint: (name: string) => t('plugins.paletteHint', { name }),
  get slashGroup() { return t('plugins.slashGroup') },
  slashSubtext: (name: string) => t('plugins.slashSubtext', { name }),

  // admin
  get adminTitle() { return t('plugins.adminTitle') },
  adminIntro: (dir: string) => t('plugins.adminIntro', { dir }),
  get adminEmpty() { return t('plugins.adminEmpty') },
  get adminApprove() { return t('plugins.adminApprove') },
  get adminReapprove() { return t('plugins.adminReapprove') },
  get adminDisable() { return t('plugins.adminDisable') },
  get adminRemove() { return t('plugins.adminRemove') },
  get adminRequested() { return t('plugins.adminRequested') },
  get adminCommands() { return t('plugins.adminCommands') },
  get adminBlocks() { return t('plugins.adminBlocks') },
  get adminHash() { return t('plugins.adminHash') },
  adminApprovedBy: (who: string | null, when: string) =>
    t('plugins.adminApprovedBy', { who: who ?? t('plugins.unknownUser'), when }),
  adminConfirmApprove: (name: string, perms: string[]) =>
    t('plugins.adminConfirmApprove', {
      name,
      perms: perms.length ? perms.join(', ') : t('plugins.noPermissions'),
    }),
  adminConfirmRemove: (name: string) => t('plugins.adminConfirmRemove', { name }),
  get adminConfirmLabel() { return t('plugins.adminConfirmLabel') },
  get adminRemoveLabel() { return t('common.delete') },
  get adminChanged() { return t('plugins.adminChanged') },
  status: keyed({
    invalid: 'plugins.statusInvalid',
    missing: 'plugins.statusMissing',
    'not-approved': 'plugins.statusNotApproved',
    'needs-reapproval': 'plugins.statusNeedsReapproval',
    enabled: 'plugins.statusEnabled',
    disabled: 'plugins.statusDisabled',
  }),
  permissionHelp: keyed({
    commands: 'plugins.permCommands',
    'read:pages': 'plugins.permReadPages',
    'write:pages': 'plugins.permWritePages',
    blocks: 'plugins.permBlocks',
    storage: 'plugins.permStorage',
  }),
}
