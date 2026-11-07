import core from './en/core'
import authAdmin from './en/auth-admin'
import pages from './en/pages'
import graphCanvas from './en/graph-canvas'
import shell from './en/shell'
import editor from './en/editor'
import lib from './en/lib'
import collection from './en/collection'
import templates from './en/templates'
import workspaceAdmin from './en/workspace-admin'
import notifications from './en/notifications'
import largePages from './en/large-pages'
import split from './en/split'
import shareLinks from './en/share-links'

// English dictionary — the source of truth for every key. Each area file is owned by one part of
// the UI; keys are 'screen.key' and must be unique across files.
export const en = {
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
  ...largePages,
  ...split,
  ...shareLinks,
}

export type MessageKey = keyof typeof en
