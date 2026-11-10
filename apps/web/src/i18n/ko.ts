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
import rowTemplates from './ko/row-templates'
import workspaceAdmin from './ko/workspace-admin'
import notifications from './ko/notifications'
import largePages from './ko/large-pages'
import split from './ko/split'
import shareLinks from './ko/share-links'
import webhooks from './ko/webhooks'
import slack from './ko/slack'
import apiTokens from './ko/api-tokens'
import adminStatus from './ko/admin-status'
import pageAccess from './ko/page-access'
import shortcuts from './ko/shortcuts'
import later from './ko/later'
import suggestions from './ko/suggestions'
import revert from './ko/revert'
import charts from './ko/charts'

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
  ...rowTemplates,
  ...workspaceAdmin,
  ...notifications,
  ...largePages,
  ...split,
  ...shareLinks,
  ...webhooks,
  ...slack,
  ...apiTokens,
  ...adminStatus,
  ...pageAccess,
  ...shortcuts,
  ...later,
  ...suggestions,
  ...revert,
  ...charts,
}
