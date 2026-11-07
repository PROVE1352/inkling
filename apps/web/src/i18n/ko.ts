import type { MessageKey } from './en'
import core from './ko/core'
import authAdmin from './ko/auth-admin'
import pages from './ko/pages'
import graphCanvas from './ko/graph-canvas'
import shell from './ko/shell'
import editor from './ko/editor'
import lib from './ko/lib'
import collection from './ko/collection'
import templates from './ko/templates'
import workspaceAdmin from './ko/workspace-admin'
import notifications from './ko/notifications'

// Korean dictionary. Missing keys fall back to English (see i18n/index.ts).
export const ko: Partial<Record<MessageKey, string>> = {
  ...core,
  ...authAdmin,
  ...pages,
  ...graphCanvas,
  ...shell,
  ...editor,
  ...lib,
  ...collection,
  ...templates,
  ...workspaceAdmin,
  ...notifications,
}
