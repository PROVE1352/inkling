// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// MCP connection settings per client (docs/adr/2020-*).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MCP_CLIENTS,
  MCP_PROFILES,
  MCP_TOKEN_AUTH_ENABLED,
  TOKEN_PLACEHOLDER,
  buildMcpConfig,
  isAgentConnectionToken,
  mcpServerUrl,
  shellQuote,
} from './mcpConfig'

const origin = 'https://notes.example.com'
const secret = 'ink_agt_' + 'A'.repeat(43)

describe('mcpServerUrl', () => {
  it('full is the plain /mcp URL (the server default), core adds ?profile=core', () => {
    assert.equal(mcpServerUrl(origin, 'full'), 'https://notes.example.com/mcp')
    assert.equal(mcpServerUrl(origin, 'core'), 'https://notes.example.com/mcp?profile=core')
    assert.equal(mcpServerUrl('http://localhost:3001/', 'full'), 'http://localhost:3001/mcp')
  })
})

describe('buildMcpConfig', () => {
  it('Claude Code: one command; the core URL is quoted so zsh does not glob the ?', () => {
    assert.equal(
      buildMcpConfig({ client: 'claude-code', auth: 'oauth', profile: 'full', origin }).text,
      'claude mcp add --transport http inkling https://notes.example.com/mcp',
    )
    assert.equal(
      buildMcpConfig({ client: 'claude-code', auth: 'oauth', profile: 'core', origin }).text,
      "claude mcp add --transport http inkling 'https://notes.example.com/mcp?profile=core'",
    )
  })

  it('Claude Code with a token: --header with the placeholder, or the token just created', () => {
    const ph = buildMcpConfig({ client: 'claude-code', auth: 'token', profile: 'full', origin })
    assert.equal(ph.text, `claude mcp add --transport http inkling https://notes.example.com/mcp --header 'Authorization: Bearer ${TOKEN_PLACEHOLDER}'`)
    assert.equal(ph.usesPlaceholder, true)
    const filled = buildMcpConfig({ client: 'claude-code', auth: 'token', profile: 'full', origin, token: secret })
    assert.match(filled.text, new RegExp(`--header 'Authorization: Bearer ${secret}'$`))
    assert.equal(filled.usesPlaceholder, false)
  })

  it('claude.ai / Claude Desktop: the URL; with a token, the request header value carries "Bearer "', () => {
    const o = buildMcpConfig({ client: 'claude-ai', auth: 'oauth', profile: 'core', origin })
    assert.equal(o.kind, 'url')
    assert.equal(o.text, 'https://notes.example.com/mcp?profile=core')
    assert.equal(o.headerValue, undefined)
    const t = buildMcpConfig({ client: 'claude-ai', auth: 'token', profile: 'full', origin, token: secret })
    assert.equal(t.text, 'https://notes.example.com/mcp')
    assert.equal(t.headerValue, `Bearer ${secret}`)
    assert.equal(t.usesPlaceholder, false)
    const p = buildMcpConfig({ client: 'claude-ai', auth: 'token', profile: 'full', origin })
    assert.equal(p.headerValue, `Bearer ${TOKEN_PLACEHOLDER}`)
    assert.equal(p.usesPlaceholder, true)
  })

  it('Cursor: mcpServers.inkling.url, headers only with a token', () => {
    const o = JSON.parse(buildMcpConfig({ client: 'cursor', auth: 'oauth', profile: 'full', origin }).text)
    assert.deepEqual(o, { mcpServers: { inkling: { url: 'https://notes.example.com/mcp' } } })
    const t = JSON.parse(buildMcpConfig({ client: 'cursor', auth: 'token', profile: 'full', origin, token: secret }).text)
    assert.deepEqual(t.mcpServers.inkling.headers, { Authorization: `Bearer ${secret}` })
  })

  it('VS Code: servers.inkling with type http; the token goes through an input prompt, never into the file', () => {
    const o = JSON.parse(buildMcpConfig({ client: 'vscode', auth: 'oauth', profile: 'full', origin }).text)
    assert.deepEqual(o, { servers: { inkling: { type: 'http', url: 'https://notes.example.com/mcp' } } })
    const r = buildMcpConfig({ client: 'vscode', auth: 'token', profile: 'full', origin, token: secret })
    const t = JSON.parse(r.text)
    assert.equal(t.servers.inkling.headers.Authorization, 'Bearer ${input:inkling-token}')
    assert.equal(t.inputs[0].id, 'inkling-token')
    assert.equal(t.inputs[0].password, true)
    assert.doesNotMatch(r.text, /ink_agt_/)
    assert.equal(r.usesPlaceholder, false)
  })

  it('no Windsurf: its documented format could not be confirmed (docs/adr/2020-*)', () => {
    assert.equal(MCP_CLIENTS.includes('windsurf'), false)
  })

  it('generic: mcpServers with type http and url', () => {
    const o = JSON.parse(buildMcpConfig({ client: 'generic', auth: 'oauth', profile: 'full', origin }).text)
    assert.deepEqual(o, { mcpServers: { inkling: { type: 'http', url: 'https://notes.example.com/mcp' } } })
  })

  it('every combination: OAuth never mentions a token; the URL always carries the profile', () => {
    for (const client of MCP_CLIENTS)
      for (const profile of MCP_PROFILES)
        for (const auth of ['oauth', 'token'] as const) {
          const r = buildMcpConfig({ client, auth, profile, origin, token: secret })
          assert.ok(r.text.length > 0)
          if (auth === 'oauth') {
            assert.doesNotMatch(r.text, /Authorization|ink_pat_|ink_agt_|<YOUR/)
            assert.equal(r.headerValue, undefined)
          }
          assert.equal(r.text.includes('profile=core'), profile === 'core', `${client} ${profile}`)
        }
  })
})

describe('token sign-in uses agent connection tokens only (docs/adr/2060-*)', () => {
  it('is on, and its placeholder names an agent connection token', () => {
    assert.equal(MCP_TOKEN_AUTH_ENABLED, true)
    assert.match(TOKEN_PLACEHOLDER, /AGENT_TOKEN/)
  })

  it('never fills in a personal API token (401 at /mcp): the placeholder stays', () => {
    const pat = 'ink_pat_' + 'P'.repeat(43)
    for (const client of MCP_CLIENTS) {
      const r = buildMcpConfig({ client, auth: 'token', profile: 'full', origin, token: pat })
      assert.doesNotMatch(r.text + (r.headerValue ?? ''), /ink_pat_/, client)
    }
    assert.equal(isAgentConnectionToken(pat), false)
    assert.equal(isAgentConnectionToken(secret), true)
    assert.equal(isAgentConnectionToken(null), false)
  })
})

describe('shellQuote', () => {
  it('leaves plain words alone and single-quotes the rest', () => {
    assert.equal(shellQuote('https://a.example/mcp'), 'https://a.example/mcp')
    assert.equal(shellQuote('a b'), "'a b'")
    assert.equal(shellQuote("it's"), `'it'\\''s'`)
  })
})
