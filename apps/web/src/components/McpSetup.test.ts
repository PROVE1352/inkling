// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// Connection settings generator on /settings/connections (docs/adr/2020-*), rendered without a browser.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLocaleChoice } from '../i18n'
import { McpSetup } from './McpSetup'
import { MCP_TOKEN_AUTH_ENABLED, TOKEN_PLACEHOLDER } from '../lib/mcpConfig'

const origin = 'https://notes.example.com'
const secret = 'ink_agt_' + 'B'.repeat(43)
const render = (props) => renderToStaticMarkup(createElement(McpSetup, { origin, secret: null, ...props }))
const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const configText = (html: string) => unescape(html.match(/data-testid="mcp-config">([\s\S]*?)<\/pre>/)?.[1] ?? '')

describe('McpSetup', () => {
  setLocaleChoice('en')

  it('defaults to Claude Code, all tools, sign-in: the one-line command', () => {
    const html = render({})
    assert.equal(configText(html), 'claude mcp add --transport http inkling https://notes.example.com/mcp')
    assert.match(html, /data-testid="mcp-url">https:\/\/notes\.example\.com\/mcp</)
    // every client of the list is offered, Windsurf is not
    for (const name of ['Claude Code', 'Claude Desktop · claude.ai', 'Cursor', 'VS Code', 'Other app']) assert.match(html, new RegExp(name))
    assert.doesNotMatch(html, /Windsurf/)
  })

  it('token sign-in is offered: agent connection tokens work at /mcp (docs/adr/2060-*)', () => {
    assert.equal(MCP_TOKEN_AUTH_ENABLED, true)
    const html = render({ initial: { auth: 'token' } })
    assert.match(html, /data-testid="mcp-auth"/)
    assert.match(html, /Agent connection token/)
    // the token it asks for is the agent connection token, never a personal API token
    assert.doesNotMatch(html, /Personal API token/)
    assert.match(html, /href="#agent-tokens"/)
  })

  it('a token just made switches the settings to it, filled in, without choosing token sign-in first', () => {
    const html = render({ secret })
    assert.match(html, /class="mt-0.5" name="mcp-auth" checked=""\/>\<span class="flex min-w-0 flex-col"><span class="font-medium text-ink">Agent connection token/)
    assert.match(configText(html), new RegExp(`--header 'Authorization: Bearer ${secret}'$`))
    assert.match(html, /Filled in with the token you just created/)
  })

  it('a personal API token handed in is never filled into the settings', () => {
    const html = render({ secret: 'ink_pat_' + 'C'.repeat(43), initial: { auth: 'token' } })
    assert.doesNotMatch(html, /ink_pat_/)
    assert.match(configText(html), new RegExp(TOKEN_PLACEHOLDER))
  })

  it('with token sign-in on: the placeholder until a token was just created, then that token', () => {
    const empty = render({ tokenAuthEnabled: true, initial: { auth: 'token' } })
    assert.match(empty, /data-testid="mcp-auth"/)
    assert.match(configText(empty), new RegExp(`--header 'Authorization: Bearer ${TOKEN_PLACEHOLDER}'`))
    assert.match(empty, /href="#agent-tokens"/)
    const filled = render({ tokenAuthEnabled: true, secret, initial: { auth: 'token' } })
    assert.match(configText(filled), new RegExp(`Bearer ${secret}'$`))
    assert.doesNotMatch(filled, /href="#agent-tokens"/)
  })

  it('claude.ai with a token: the URL plus the request header value', () => {
    const html = render({ tokenAuthEnabled: true, secret, initial: { client: 'claude-ai', auth: 'token', profile: 'core' } })
    assert.equal(configText(html), 'https://notes.example.com/mcp?profile=core')
    assert.match(html, /data-testid="mcp-header"/)
    assert.match(html, new RegExp(`Bearer ${secret}`))
  })

  it('VS Code with a token never writes it into the file', () => {
    const html = render({ tokenAuthEnabled: true, secret, initial: { client: 'vscode', auth: 'token' } })
    assert.doesNotMatch(configText(html), /ink_agt_/)
    assert.match(configText(html), /\$\{input:inkling-token\}/)
  })

  it('core profile changes both the URL and the config', () => {
    const html = render({ initial: { client: 'cursor', profile: 'core' } })
    assert.match(html, /data-testid="mcp-url">https:\/\/notes\.example\.com\/mcp\?profile=core</)
    assert.deepEqual(JSON.parse(configText(html)), { mcpServers: { inkling: { url: 'https://notes.example.com/mcp?profile=core' } } })
  })

  it('narrow screens: long lines scroll inside the box, rows can shrink', () => {
    const html = render({ initial: { client: 'vscode' } })
    assert.match(html, /<pre class="[^"]*overflow-auto[^"]*whitespace-pre/)
    assert.match(html, /data-testid="mcp-setup"/)
    assert.match(html, /class="flex min-w-0 flex-col gap-3/)
  })

  it('local http opens the help, https leaves it closed', () => {
    assert.match(render({ origin: 'http://localhost:3001' }), /<details class="[^"]*" open="">/)
    assert.doesNotMatch(render({}), /<details[^>]* open=/)
  })

  it('Korean labels', () => {
    setLocaleChoice('ko')
    try {
      assert.match(render({}), /AI 앱 연결/)
    } finally {
      setLocaleChoice('en')
    }
  })
})
