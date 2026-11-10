import core from './en/core'
import authAdmin from './en/auth-admin'
import pages from './en/pages'
import graphCanvas from './en/graph-canvas'
import shell from './en/shell'
import editor from './en/editor'
import lib from './en/lib'
import collection from './en/collection'
import templates from './en/templates'
import rowTemplates from './en/row-templates'
import workspaceAdmin from './en/workspace-admin'
import notifications from './en/notifications'
import largePages from './en/large-pages'
import split from './en/split'
import shareLinks from './en/share-links'
import webhooks from './en/webhooks'
import slack from './en/slack'
import apiTokens from './en/api-tokens'
import adminStatus from './en/admin-status'
import pageAccess from './en/page-access'
import shortcuts from './en/shortcuts'
import later from './en/later'
import suggestions from './en/suggestions'
import revert from './en/revert'
import charts from './en/charts'
import pageWorkspace from './en/page-workspace'
import forms from './en/forms'
import teamAgents from './en/team-agents'
import mcpSetup from './en/mcp-setup'
import dbView from './en/db-view'
import diagramsLinks from './en/diagrams-links'
import oauthCimd from './en/oauth-cimd'
import clip from './en/clip'
import push from './en/push'
import automations from './en/automations'

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
  ...pageWorkspace,
  ...forms,
  ...teamAgents,
  ...mcpSetup,
  ...dbView,
  ...diagramsLinks,
  ...oauthCimd,
  ...clip,
  ...push,
  ...automations,
}

export type MessageKey = keyof typeof en
