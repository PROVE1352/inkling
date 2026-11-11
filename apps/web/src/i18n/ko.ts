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
import pageWorkspace from './ko/page-workspace'
import forms from './ko/forms'
import teamAgents from './ko/team-agents'
import mcpSetup from './ko/mcp-setup'
import dbView from './ko/db-view'
import diagramsLinks from './ko/diagrams-links'
import oauthCimd from './ko/oauth-cimd'
import clip from './ko/clip'
import push from './ko/push'
import automations from './ko/automations'
import offline from './ko/offline'
import workspaceGroups from './ko/workspace-groups'
import integration018 from './ko/integration-018'
import publicView from './ko/public-view'
import publicCharts from './ko/public-charts'
import onboarding from './ko/onboarding'
import imageViewer from './ko/image-viewer'
import columns from './ko/columns'
import pdfPreview from './ko/pdf-preview'
import limits from './ko/limits'

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
  ...offline,
  ...workspaceGroups,
  ...integration018,
  ...publicView,
  ...publicCharts,
  ...onboarding,
  ...imageViewer,
  ...columns,
  ...pdfPreview,
  ...limits,
}
