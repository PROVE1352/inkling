import { randomBytes } from 'node:crypto'

/**
 * Plugin frame host page + in-frame SDK.
 *
 * Every plugin instance (command worker or block renderer) runs in
 *   <iframe sandbox="allow-scripts" src="/api/plugin-frame/<id>/<hash>/index.html">
 * The page is ALSO served with `Content-Security-Policy: sandbox allow-scripts`, so even when the
 * URL is opened directly as a top-level tab it gets an opaque origin: no cookies, no
 * localStorage, no same-origin access to the app, and `connect-src 'none'` blocks fetch/XHR/
 * WebSocket/EventSource/beacons. Only two scripts may run, both pinned by a per-response nonce:
 * the app-owned SDK and the plugin's approved bundle. Dynamically injected scripts (no nonce)
 * are refused, and there is no 'unsafe-eval'.
 */

/** Bumped when the parent<->frame protocol changes. Part of the SDK URL. */
export const SDK_VERSION = 1
export const SDK_PATH = `/api/plugin-sdk/v${SDK_VERSION}.js`

export function newNonce(): string {
  return randomBytes(16).toString('base64')
}

/** CSP for the frame document. Exported for tests. */
export function frameCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    // Plugin UIs need inline styles; CSS inside an opaque-origin sandbox cannot reach the app.
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    // Only the app itself may embed plugin frames.
    "frame-ancestors 'self'",
    // Opaque origin even if opened top-level; no same-origin, popups, forms, top navigation.
    'sandbox allow-scripts',
  ].join('; ')
}

/** CSP for the JS responses themselves (they are never documents, but be strict anyway). */
export const SCRIPT_RESPONSE_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox"

export const FRAME_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), clipboard-read=(), display-capture=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
}

const escAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Host document. `pluginId`/`hash` are regex-validated by the caller; escaped anyway. */
export function frameHtml(pluginId: string, hash: string, nonce: string): string {
  const n = escAttr(nonce)
  const bundle = `/api/plugin-frame/${encodeURIComponent(pluginId)}/${encodeURIComponent(hash)}/main.js`
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark}
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2328}
:root[data-theme="dark"] body{color:#e6e6e6}
</style>
<script nonce="${n}" src="${escAttr(SDK_PATH)}"></script>
<script nonce="${n}" src="${escAttr(bundle)}"></script>
</head><body></body></html>
`
}

/**
 * The in-frame SDK (plain ES2020, no build step). It is convenience only — every check that
 * matters happens in the parent broker (apps/web/src/plugins/broker.ts), because plugin code runs
 * in the same realm and can bypass or replace anything here.
 *
 * Wire protocol (all messages are JSON *strings* on a MessageChannel port):
 *   frame -> parent  {id:number, method:string, params:object}     RPC request
 *   frame -> parent  {pong:number}                                  heartbeat reply
 *   parent -> frame  {id:number, ok:true, result} | {id, ok:false, error:{code,message}}
 *   parent -> frame  {event:string, ...}                            init, command, block.data, ping, theme
 * Handshake: parent posts the string "inkling-plugin-init:v1" with a transferred MessagePort.
 */
export const SDK_SOURCE = `/* Inkling plugin SDK v${SDK_VERSION} — served by the app. */
(function () {
  'use strict';
  var INIT = 'inkling-plugin-init:v${SDK_VERSION}';
  var port = null, seq = 0, ctx = null;
  var pending = new Map(), queue = [];
  var commandHandlers = new Map(), blockRenderers = new Map();
  var blockState = null, readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });

  function post(obj) {
    var s = JSON.stringify(obj);
    if (port) port.postMessage(s); else queue.push(s);
  }
  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var t = setTimeout(function () {
        pending.delete(id);
        reject(new Error('Request timed out: ' + method));
      }, 20000);
      pending.set(id, { resolve: resolve, reject: reject, t: t });
      post({ id: id, method: method, params: params || {} });
    });
  }
  function applyTheme(theme) {
    if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
  }
  function reportError(where, err) {
    try { console.error('[plugin] ' + where, err); } catch (e) {}
  }

  var lastHeight = 0, resizeQueued = false;
  function queueResize() {
    if (!ctx || ctx.mode !== 'block' || resizeQueued) return;
    resizeQueued = true;
    // setTimeout, not requestAnimationFrame: rAF is paused in off-screen cross-origin frames.
    setTimeout(function () {
      resizeQueued = false;
      // Measure the body (not <html>, whose height is at least the iframe viewport and so
      // could never shrink).
      var b = document.body;
      var h = Math.ceil(Math.max(b.scrollHeight, b.getBoundingClientRect().height));
      if (Math.abs(h - lastHeight) < 2) return;
      lastHeight = h;
      call('block.resize', { height: h }).catch(function () {});
    }, 30);
  }

  function renderBlock() {
    if (!ctx || ctx.mode !== 'block' || !blockState) return;
    var r = blockRenderers.get(ctx.blockType);
    if (!r) return;
    var props = {
      data: blockState.data,
      editable: !!blockState.editable,
      setData: function (data) {
        return call('block.setData', { data: data });
      }
    };
    try {
      if (blockState.rendered && typeof r.update === 'function') r.update(document.body, props);
      else { document.body.textContent = ''; r.render(document.body, props); }
      blockState.rendered = true;
    } catch (err) { reportError('block render failed', err); }
    queueResize();
  }

  function onPortMessage(e) {
    if (typeof e.data !== 'string') return;
    var m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (!m || typeof m !== 'object') return;
    if (typeof m.id === 'number' && pending.has(m.id)) {
      var p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.t);
      if (m.ok) p.resolve(m.result);
      else p.reject(Object.assign(new Error((m.error && m.error.message) || 'Request failed'), { code: m.error && m.error.code }));
      return;
    }
    switch (m.event) {
      case 'ping': post({ pong: m.n }); break;
      case 'init':
        ctx = m.context || {};
        applyTheme(ctx.theme);
        if (ctx.mode === 'block') {
          blockState = { data: ctx.data || {}, editable: !!ctx.editable, rendered: false };
          if (typeof ResizeObserver === 'function') new ResizeObserver(queueResize).observe(document.body);
          renderBlock();
        }
        readyResolve(ctx);
        break;
      case 'theme': applyTheme(m.theme); break;
      case 'block.data':
        if (blockState) { blockState.data = m.data || {}; blockState.editable = !!m.editable; renderBlock(); }
        break;
      case 'command': {
        var h = commandHandlers.get(m.commandId);
        if (h) Promise.resolve().then(function () { return h(m.context || {}); }).catch(function (err) { reportError('command failed', err); });
        break;
      }
    }
  }

  window.addEventListener('message', function (e) {
    if (port || e.source !== window.parent || e.data !== INIT || !e.ports || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = onPortMessage;
    var q = queue; queue = [];
    for (var i = 0; i < q.length; i++) port.postMessage(q[i]);
  });

  var api = {
    sdkVersion: ${SDK_VERSION},
    ready: ready,
    context: function () { return ctx; },
    commands: {
      register: function (id, handler) {
        if (typeof handler !== 'function') throw new TypeError('handler must be a function');
        commandHandlers.set(id, handler);
        return call('commands.register', { id: id });
      }
    },
    blocks: {
      register: function (type, renderer) {
        if (!renderer || typeof renderer.render !== 'function') throw new TypeError('renderer.render must be a function');
        blockRenderers.set(type, renderer);
        var p = call('blocks.register', { type: type });
        renderBlock();
        return p;
      }
    },
    pages: {
      get: function (pageId) { return call('pages.get', { pageId: pageId }); },
      search: function (query, workspaceId) { return call('pages.search', { query: query, workspaceId: workspaceId }); },
      update: function (pageId, markdown, opts) {
        return call('pages.update', { pageId: pageId, markdown: markdown, mode: (opts && opts.mode) || 'replace' });
      }
    },
    storage: {
      get: function (key) { return call('storage.get', { key: key }); },
      set: function (key, value) { return call('storage.set', { key: key, value: value }); },
      delete: function (key) { return call('storage.delete', { key: key }); },
      keys: function () { return call('storage.keys', {}); }
    },
    ui: {
      notice: function (message) { return call('ui.notice', { message: String(message) }); }
    }
  };
  Object.freeze(api.commands); Object.freeze(api.blocks); Object.freeze(api.pages);
  Object.freeze(api.storage); Object.freeze(api.ui);
  Object.defineProperty(window, 'inkling', { value: Object.freeze(api), writable: false, configurable: false });
})();
`
