// @ts-nocheck — Node test file (node:test types are not part of the web tsconfig); not bundled.
// A screen that cannot be drawn shows a notice with a reload button instead of a white page
// (docs/adr/2324-*): the boundaries' state changes, what they draw, and the static notice index.html
// keeps for an app whose script never ran.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { setLocaleChoice } from '../i18n'
import { AppErrorBoundary, CrashScreen, isChunkLoadError } from './AppErrorBoundary'

setLocaleChoice('en')

describe('isChunkLoadError', () => {
  it('knows the failed dynamic import messages of Chrome, Firefox and Safari', () => {
    assert.equal(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://x/assets/PageView-a1.js')), true)
    assert.equal(isChunkLoadError(new TypeError('error loading dynamically imported module: http://x/assets/PageView-a1.js')), true)
    assert.equal(isChunkLoadError(new TypeError('Importing a module script failed.')), true)
    assert.equal(isChunkLoadError(new Error('Unable to preload CSS for /assets/PageView-a1.css')), true)
  })
  it('anything else is a render error', () => {
    assert.equal(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'name')")), false)
    assert.equal(isChunkLoadError('boom'), false)
    assert.equal(isChunkLoadError(null), false)
  })
})

describe('AppErrorBoundary', () => {
  it('an error switches it to the notice', () => {
    const err = new Error('boom')
    assert.deepEqual(AppErrorBoundary.getDerivedStateFromError(err), { error: err, failed: true })
  })

  it('without an error it draws its children', () => {
    const b = new AppErrorBoundary({ children: createElement('p', null, 'page body') })
    assert.equal(renderToStaticMarkup(b.render()), '<p>page body</p>')
  })

  it('after an error it draws the notice with a reload button and the error text', () => {
    const b = new AppErrorBoundary({ children: createElement('p', null, 'page body') })
    b.state = { ...b.state, error: new TypeError("Cannot read properties of undefined (reading 'name')"), failed: true }
    const html = renderToStaticMarkup(b.render())
    assert.ok(!html.includes('page body'))
    assert.match(html, /data-testid="app-crash"/)
    assert.match(html, /role="alert"/)
    assert.match(html, /This screen could not be shown/)
    assert.match(html, /Reloading the page usually fixes this/)
    assert.match(html, /<button[^>]*>Reload<\/button>/)
    assert.match(html, /reading &#x27;name&#x27;/)
  })

  it('a thrown non-Error value still draws the notice (failed, not the value, decides)', () => {
    const b = new AppErrorBoundary({ children: 'x' })
    b.state = { ...b.state, ...AppErrorBoundary.getDerivedStateFromError(undefined) }
    assert.match(renderToStaticMarkup(b.render()), /data-testid="app-crash"/)
  })

  it('a chunk that failed to load says so', () => {
    const html = renderToStaticMarkup(createElement(CrashScreen, { error: new TypeError('Failed to fetch dynamically imported module: /assets/PageView-a1.js') }))
    assert.match(html, /Part of the app could not be loaded/)
  })

  it('the page-area boundary clears its error when the route changes, not before', () => {
    const props = { children: 'x', inline: true, resetKey: '/w/1/p/a' }
    const failed = { error: new Error('boom'), failed: true, key: '/w/1/p/a' }
    assert.equal(AppErrorBoundary.getDerivedStateFromProps(props, failed), null)
    assert.deepEqual(AppErrorBoundary.getDerivedStateFromProps({ ...props, resetKey: '/w/1/p/b' }, failed), {
      key: '/w/1/p/b',
      error: null,
      failed: false,
    })
  })

  it('the notice is in Korean when the app is', () => {
    setLocaleChoice('ko')
    try {
      const html = renderToStaticMarkup(createElement(CrashScreen, { error: new Error('boom') }))
      assert.match(html, /이 화면을 표시하지 못했습니다/)
      assert.match(html, />새로고침<\/button>/)
    } finally {
      setLocaleChoice('en')
    }
  })
})

describe('boot notice (index.html)', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

  it('#root starts with the notice and a reload link, so a script that never runs leaves no blank page', () => {
    const root = /<div id="root">([\s\S]*?)<\/div><\/div>/.exec(html)?.[1] ?? ''
    assert.match(root, /class="nd-boot-fallback"/)
    assert.match(root, /data-testid="boot-fallback"/)
    assert.equal((root.match(/<a href="">/g) ?? []).length, 2, 'a reload link in English and in Korean')
  })

  it('the notice stays hidden for the first 12 s and needs no script (CSP script-src self)', () => {
    const rule = /\.nd-boot-fallback \{([\s\S]*?)\}/.exec(css)?.[1] ?? ''
    assert.match(rule, /visibility: hidden/)
    assert.match(rule, /animation: nd-boot-reveal 0s linear 12s forwards/)
    assert.match(css, /@keyframes nd-boot-reveal \{\s*to \{\s*visibility: visible;/)
    assert.ok(!/<script>/.test(html), 'no inline script in index.html')
  })
})
