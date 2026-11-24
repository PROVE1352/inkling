// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// "Your agent is connected" and the sidebar default that follows it (docs/adr/2390-*): the notice is due
// only when this page load saw "not connected" and then "connected" (never for someone connected before,
// never twice); the activity menu shows by default only for a person with a connected agent who never
// arranged the sidebar.
import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { SIDEBAR_MENU_DEFAULT_HIDDEN, SIDEBAR_MENU_IDS } from '@inkling/shared'
import { agentJustConnected, agentNoticeState, markAgentNoticeShown, observeAgentConnected, resetAgentNoticeForTests } from './agentNotice'
import { AGENT_DEFAULT_MENU, sidebarDefaultHidden } from './sidebarDefault'
import { resolveSidebarMenu, setEntryHidden, toSidebarPrefs, visibleSidebarMenu } from '../lib/sidebarMenu'

describe('agentJustConnected', () => {
  it('only false then true', () => {
    assert.equal(agentJustConnected(false, true), true)
    assert.equal(agentJustConnected(undefined, true), false, 'the first answer of a load already says connected')
    assert.equal(agentJustConnected(true, true), false)
    assert.equal(agentJustConnected(false, false), false)
    assert.equal(agentJustConnected(true, false), false)
    assert.equal(agentJustConnected(false, undefined), false, 'an answer without the field (an older server)')
  })
})

describe('the notice over a page load', () => {
  beforeEach(() => resetAgentNoticeForTests())

  it('connected before (first answer true): never due', () => {
    observeAgentConnected('u1', true)
    observeAgentConnected('u1', true)
    assert.equal(agentNoticeState().due, false)
  })

  it('not connected, then connected: due once; shown once by whichever place shows it first', () => {
    observeAgentConnected('u1', false)
    observeAgentConnected('u1', false)
    assert.equal(agentNoticeState().due, false)
    observeAgentConnected('u1', true)
    assert.deepEqual(agentNoticeState(), { due: true, shown: false })
    markAgentNoticeShown()
    assert.deepEqual(agentNoticeState(), { due: true, shown: true })
    // more answers (other components, refetches) change nothing
    observeAgentConnected('u1', true)
    assert.deepEqual(agentNoticeState(), { due: true, shown: true })
  })

  it('unknown answers (offline, onboarding off) are ignored; another person in the same tab starts fresh', () => {
    observeAgentConnected('u1', undefined)
    observeAgentConnected('u1', true)
    assert.equal(agentNoticeState().due, false)
    observeAgentConnected('u2', true)
    assert.equal(agentNoticeState().due, false)
  })
})

describe('sidebar default with a connected agent', () => {
  const known = SIDEBAR_MENU_IDS
  const empty = { order: [], hidden: [] }

  it('no agent: the default of 0.13 (search, later, due, calendar)', () => {
    assert.deepEqual(sidebarDefaultHidden(false), SIDEBAR_MENU_DEFAULT_HIDDEN)
    assert.deepEqual(sidebarDefaultHidden(undefined), SIDEBAR_MENU_DEFAULT_HIDDEN)
    assert.deepEqual(visibleSidebarMenu(empty, known, sidebarDefaultHidden(false)), ['search', 'later', 'due', 'calendar'])
  })

  it('an agent and nothing stored: activity joins them, in its place', () => {
    assert.equal(AGENT_DEFAULT_MENU, 'activity')
    assert.deepEqual(visibleSidebarMenu(empty, known, sidebarDefaultHidden(true)), ['search', 'later', 'due', 'calendar', 'activity'])
    // hiding another menu keeps activity (the same default on both sides) and stores only that change
    const def = sidebarDefaultHidden(true)
    const next = toSidebarPrefs(setEntryHidden(resolveSidebarMenu(empty, known, def), 'later', true), known, empty, def)
    assert.deepEqual(visibleSidebarMenu(next, known, def), ['search', 'due', 'calendar', 'activity'])
    // hiding activity itself is stored and kept
    const off = toSidebarPrefs(setEntryHidden(resolveSidebarMenu(empty, known, def), 'activity', true), known, empty, def)
    assert.ok(off.hidden.includes('activity'))
    assert.deepEqual(visibleSidebarMenu(off, known, def), ['search', 'later', 'due', 'calendar'])
  })

  it('an arrangement stored: kept as it is, agent or not', () => {
    const mine = { order: [], hidden: ['threads', 'graph', 'tags', 'shared', 'activity', 'today', 'calendar'] }
    assert.deepEqual(visibleSidebarMenu(mine, known, sidebarDefaultHidden(true)), ['search', 'later', 'due'])
    assert.deepEqual(visibleSidebarMenu(mine, known, sidebarDefaultHidden(false)), ['search', 'later', 'due'])
    const withActivity = { order: [], hidden: ['threads', 'graph', 'tags', 'shared', 'today'] }
    assert.deepEqual(visibleSidebarMenu(withActivity, known, sidebarDefaultHidden(false)), ['search', 'later', 'due', 'calendar', 'activity'])
  })
})
