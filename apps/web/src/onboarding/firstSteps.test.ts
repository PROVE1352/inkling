// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// First steps from the new person's screens (docs/adr/2380-*): the sample offer on the empty home, the sample
// link on empty agent screens, and the connect screen the "Connect an AI agent" buttons land on.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLocaleChoice } from '../i18n'
import { McpSetup } from '../components/McpSetup'
import { en } from '../i18n/en'
import { ko } from '../i18n/ko'
import { shortcutById } from '../lib/shortcuts/registry'
import { scoreText } from '../lib/shortcuts/search'
import { AI_CONNECT_HINT_TARGET, AI_CONNECT_PATH, homeOffersSample, mcpOptionsOpen, samplePageOf, shareHint } from './firstSteps'

const WS = '11111111-1111-4111-8111-111111111111'
const dto = (over = {}) => ({
  enabled: true,
  audience: 'owner',
  intro: false,
  checklist: { show: true, collapsed: true, dismissed: false, complete: false, items: [] },
  samples: {},
  ...over,
})

describe('homeOffersSample', () => {
  it('a new member without a sample here: offered', () => {
    assert.equal(homeOffersSample(dto(), WS, false), true)
    assert.equal(homeOffersSample(dto({ audience: 'member' }), WS, false), true)
  })
  it('a sample already here: not offered (a sample in another workspace does not count)', () => {
    assert.equal(homeOffersSample(dto({ samples: { [WS]: 'p1' } }), WS, false), false)
    assert.equal(homeOffersSample(dto({ samples: { other: 'p1' } }), WS, false), true)
  })
  it('onboarding off, unknown, a guest, or the card dismissed (accounts from before): not offered', () => {
    assert.equal(homeOffersSample(null, WS, false), false)
    assert.equal(homeOffersSample(dto({ enabled: false }), WS, false), false)
    assert.equal(homeOffersSample(dto(), WS, true), false)
    assert.equal(homeOffersSample(dto({ audience: 'guest' }), WS, false), false)
    assert.equal(homeOffersSample(dto({ checklist: { show: false, collapsed: true, dismissed: true, complete: false, items: [] } }), WS, false), false)
    assert.equal(homeOffersSample(dto(), undefined, false), false)
  })
})

describe('samplePageOf', () => {
  it('the live sample in this workspace, else null', () => {
    assert.equal(samplePageOf(dto({ samples: { [WS]: 'p1' } }), WS), 'p1')
    assert.equal(samplePageOf(dto(), WS), null)
    assert.equal(samplePageOf(null, WS), null)
    assert.equal(samplePageOf(dto({ enabled: false, samples: { [WS]: 'p1' } }), WS), null)
  })
})

describe('mcpOptionsOpen', () => {
  it('closed at the defaults, open when a choice in it is not the default', () => {
    assert.equal(mcpOptionsOpen('full', 'oauth'), false)
    assert.equal(mcpOptionsOpen('core', 'oauth'), true)
    assert.equal(mcpOptionsOpen('full', 'token'), true)
  })
})

describe('the connect screen the AI agent buttons land on', () => {
  const origin = 'https://notes.example.com'
  const render = (props = {}) => renderToStaticMarkup(createElement(McpSetup, { origin, secret: null, ...props }))
  setLocaleChoice('en')

  it('goes to the per-app setup, and the hint target is on it', () => {
    assert.equal(AI_CONNECT_PATH, '/settings/connections')
    assert.equal(AI_CONNECT_HINT_TARGET, '[data-onboarding="mcp-app"]')
    assert.match(render(), /data-onboarding="mcp-app"/)
  })

  it('order: why, then the app picker with its command and copy, then the first question and how to check, then the fold', () => {
    const html = render()
    const at = (s) => {
      const i = html.indexOf(s)
      assert.ok(i >= 0, `missing ${s}`)
      return i
    }
    const order = [
      at('data-testid="mcp-why"'),
      at('data-onboarding="mcp-app"'),
      at('data-testid="mcp-client"'),
      at('data-testid="mcp-config"'),
      at('data-testid="mcp-try"'),
      at('data-testid="mcp-verify"'),
      at('data-testid="mcp-options"'),
      at('name="mcp-profile"'),
      at('data-testid="mcp-auth"'),
    ]
    assert.deepEqual([...order].sort((a, b) => a - b), order)
    assert.match(html, /reads only the sections a question needs/)
    assert.match(html, /List what is left to do on the sample page/)
  })

  it('the copy button is beside the command, not over it, and long lines wrap', () => {
    const html = render()
    assert.doesNotMatch(html, /absolute right-1\.5/)
    assert.match(html, /<pre class="[^"]*whitespace-pre-wrap \[overflow-wrap:anywhere\]/)
    assert.doesNotMatch(html, /<pre class="[^"]*break-all/)
  })

  it('the tool set and sign-in fold: closed at the defaults, open when a token was just made', () => {
    assert.match(render(), /<details class="text-xs text-sub" data-testid="mcp-options">/)
    assert.match(render({ secret: 'ink_agt_' + 'B'.repeat(43) }), /<details class="text-xs text-sub" open="" data-testid="mcp-options">/)
    assert.match(render({ initial: { profile: 'core' } }), /open="" data-testid="mcp-options"/)
  })

  it('how to check: sign-in points at Connected apps, a token at the agent token list', () => {
    assert.match(render(), /data-testid="mcp-verify">Once it is connected, the app shows up under &quot;Connected apps&quot; below/)
    assert.match(render({ initial: { auth: 'token' } }), /under &quot;Agent connection tokens&quot; below/)
  })

  it('Korean lines', () => {
    setLocaleChoice('ko')
    try {
      const html = render()
      assert.match(html, /질문에 필요한 섹션만 찾아 읽고/)
      assert.match(html, /샘플 페이지에서 남은 할 일을 정리해 줘/)
      assert.match(html, /아래 &#x27;연결된 앱&#x27;에 앱 이름이 나옵니다/)
      assert.match(html, /다른 방식/)
    } finally {
      setLocaleChoice('en')
    }
  })
})

describe('finding the connect screen and the share hint', () => {
  it('the palette finds "Manage MCP connections" by agent, AI and connect, in either language', () => {
    const def = shortcutById('app.mcp')
    const texts = [def.paletteLabel, def.label].flatMap((k) => [en[k], ko[k]])
    for (const q of ['에이전트', 'AI', 'agent', 'connect', 'MCP']) assert.ok(texts.some((x) => scoreText(x, q) > 0), q)
  })

  it('the share hint names the globe button only while public links are on', () => {
    assert.deepEqual(shareHint(false), { key: 'getStarted.item.share.hint', publicLink: true })
    assert.deepEqual(shareHint(true), { key: 'getStarted.item.share.hintInviteOnly', publicLink: false })
    for (const d of [en, ko]) {
      assert.ok(d['getStarted.item.share.hintInviteOnly'])
      assert.ok(!d['getStarted.item.share.hintInviteOnly'].includes(d === ko ? '지구본' : 'globe'))
    }
  })
})
