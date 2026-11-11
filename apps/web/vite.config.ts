import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin } from 'vite'

// Modules that are only ever loaded on demand (syntax-highlighting grammars/themes, xlsx import,
// KaTeX for pages with math — lib/katex.ts, Mermaid and the libraries only it uses — lib/mermaid.ts,
// docs/adr/2104-*).
const LAZY_ONLY = [
  /[\\/]@shikijs[\\/]langs/,
  /[\\/]@shikijs[\\/]themes/,
  /[\\/]exceljs[\\/]/,
  /[\\/]katex[\\/](?!package\.json)/,
  /[\\/]node_modules[\\/](?:mermaid|@mermaid-js|cytoscape(?:-[a-z-]+)?|elkjs|dagre-d3-es|chevrotain|@chevrotain|langium|khroma|stylis|roughjs|@braintree|@upsetjs|d3-sankey|@iconify|marked|dompurify|dayjs)[\\/]/,
  // d3 parts only Mermaid's charts use (d3-interpolate/d3-color's core is shared with the canvas: not here)
  /[\\/]node_modules[\\/](?:d3-scale|d3-scale-chromatic|d3-array|d3-format|d3-time|d3-time-format|d3-shape|d3-path|d3-hierarchy|d3-chord|d3-contour|d3-delaunay|delaunator|d3-geo|d3-polygon|d3-random|d3-brush|d3-axis|d3-fetch|d3-dsv)[\\/]/,
  /[\\/]node_modules[\\/]d3-(?:color|interpolate)[\\/]src[\\/]cubehelix\.js$/,
  // the onboarding intro motion: once per new account, fetched when it plays (docs/adr/2382-*)
  /[\\/]src[\\/]onboarding[\\/]intro[\\/]/,
  // pdf.js for the PDF preview: fetched when a preview starts loading a file (docs/adr/2480-*)
  /[\\/]pdfjs-dist[\\/]/,
]

// pdf.js data files (docs/adr/2480-*): the Adobe cMaps (CJK text needs them), the standard fonts, the
// wasm image decoders with their no-wasm fallbacks, and the ICC profiles, served from the app's own
// origin under assets/lazy/pdfjs-<version>/ (the version in the path keeps the year-long immutable
// cache of assets/ honest; under lazy/ they stay out of the precache). The scripting sandbox
// (quickjs-eval.*) is left out: the preview runs nothing from a PDF.
const PDFJS_DIR = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
const PDFJS_VERSION = (JSON.parse(readFileSync(path.join(PDFJS_DIR, 'package.json'), 'utf8')) as { version: string }).version
const PDFJS_PREFIX = `assets/lazy/pdfjs-${PDFJS_VERSION}/`
const PDFJS_DATA_DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs']
const pdfjsDataFile = (rel: string) => !/quickjs/i.test(rel)

function pdfjsDataFiles(): string[] {
  const out: string[] = []
  for (const dir of PDFJS_DATA_DIRS) {
    const abs = path.join(PDFJS_DIR, dir)
    if (!existsSync(abs)) continue
    for (const f of readdirSync(abs)) {
      const rel = `${dir}/${f}`
      if (statSync(path.join(abs, f)).isFile() && pdfjsDataFile(rel)) out.push(rel)
    }
  }
  return out
}

function pdfjsAssets(): Plugin {
  return {
    name: 'inkling-pdfjs-assets',
    generateBundle() {
      for (const rel of pdfjsDataFiles()) {
        this.emitFile({ type: 'asset', fileName: PDFJS_PREFIX + rel, source: readFileSync(path.join(PDFJS_DIR, rel)) })
      }
    },
    configureServer(server) {
      const allowed = new Set(pdfjsDataFiles())
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        if (!url.startsWith('/' + PDFJS_PREFIX)) return next()
        const rel = decodeURIComponent(url.slice(PDFJS_PREFIX.length + 1))
        if (!allowed.has(rel)) return next()
        res.setHeader('Content-Type', rel.endsWith('.wasm') ? 'application/wasm' : rel.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        res.end(readFileSync(path.join(PDFJS_DIR, rel)))
      })
    },
  }
}

// Build id (docs/adr/0990-build-id-and-version-header.md): INKLING_BUILD (e.g. a commit hash passed as
// a Docker build-arg) or a hash of the build time — works without git. It is compiled into the
// bundle (__INKLING_BUILD__) and written to dist/build.json, which the server reads at boot and
// echoes as the X-Inkling-Build header, so a tab can tell it runs an older build.
const BUILD_ID =
  process.env.INKLING_BUILD?.trim().replace(/[^\w.-]/g, '').slice(0, 40) ||
  createHash('sha256').update(`${Date.now()}-${randomBytes(8).toString('hex')}`).digest('hex').slice(0, 12)

export default defineConfig({
  define: {
    __INKLING_BUILD__: JSON.stringify(BUILD_ID),
    // Release version shown at the bottom of Settings (apps/web/package.json, bumped per release).
    __INKLING_VERSION__: JSON.stringify(
      (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version,
    ),
  },
  plugins: [
    {
      name: 'inkling-build-id',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'build.json',
          source: JSON.stringify({ build: BUILD_ID, builtAt: new Date().toISOString() }),
        })
      },
    },
    pdfjsAssets(),
    react(),
    tailwindcss(),
    VitePWA({
      // Update policy (docs/adr/0706-service-worker-update-and-precache.md): a new deploy waits
      // until the user accepts the "new version" toast (lib/pwa.ts), then skipWaiting + reload.
      // 'autoUpdate' swapped the SW under a running tab, whose lazy chunks of the old build were
      // then gone from both the precache and the server.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg', 'icons/apple-touch-icon.png', 'theme-init.js'],
      manifest: {
        name: 'Inkling',
        short_name: 'Inkling',
        description: "Notion's collaboration with Obsidian's lightness, on your own server",
        lang: 'en',
        display: 'standalone',
        // Explicit id/scope — pins the install identity and keeps navigation inside the app window (all paths).
        // Outbound links open in a new window (AppLayout).
        id: '/',
        scope: '/',
        start_url: '/',
        background_color: '#191919',
        theme_color: '#191919',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        // "Share to Inkling" from the OS share sheet (installed PWA). GET on purpose: the /clip
        // page only prefills a form and saves on a click, so no service worker fetch handler and
        // no cross-site write.
        share_target: {
          action: '/clip',
          method: 'GET',
          // Chrome warns about a share target without enctype even for GET (the default value)
          enctype: 'application/x-www-form-urlencoded',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      },
      workbox: {
        // Push and notification-click handlers live in public/push-sw.js; the generated worker
        // imports it, so the precache and update policy above stay Workbox's.
        importScripts: ['/push-sw.js'],
        // SPA fallback must never answer a server route (docs/adr/0706-*). Server routes outside
        // /api (apps/server/src/index.ts isReservedPath + root-registered routes):
        //   /api/*, /files/* (downloads), /collab (WebSocket), /mcp, /.well-known/*,
        //   /oauth/token, /oauth/register (MCP OAuth; /oauth/authorize is the SPA consent page),
        //   /ical/<token>.ics (calendar feed), /s/:token[/p/:ref] (share page HTML with
        //   per-share Open Graph / robots meta — served by the server, not the cached shell).
        // /maps is legacy (no route today) but stays excluded in case a proxy serves it.
        navigateFallbackDenylist: [
          /^\/api(\/|$)/,
          /^\/files(\/|$)/,
          /^\/collab(\/|$)/,
          /^\/maps(\/|$)/,
          /^\/mcp(\/|$)/,
          /^\/ical\//,
          /^\/s\//,
          /^\/\.well-known\//,
          /^\/oauth\/(token|register)(\/|$)/,
        ],
        // Precache the app (shell + every route chunk) but not on-demand payloads: Shiki
        // grammars/themes and exceljs (~4.5 MB) live under assets/lazy/ (chunkFileNames below)
        // and are cached on first use instead.
        globIgnores: ['**/assets/lazy/**'],
        runtimeCaching: [
          {
            // Content-hashed, immutable. No API/runtime JSON is cached by the SW — personal data
            // and permission changes must always come from the server.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/assets/lazy/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'inkling-lazy-assets',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
  build: {
    rolldownOptions: {
      output: {
        // On-demand payloads go under assets/lazy/ so the service worker can skip precaching them.
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => LAZY_ONLY.some((re) => re.test(id)))
            ? 'assets/lazy/[name]-[hash].js'
            : 'assets/[name]-[hash].js',
        // pdf.js's worker (imported with ?url, docs/adr/2480-*) is an asset, not a chunk: lazy too
        assetFileNames: (asset) =>
          (asset.names ?? []).some((n) => /^pdf\.worker/.test(n)) ? 'assets/lazy/[name]-[hash][extname]' : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/files': 'http://localhost:3001',
      '/collab': { target: 'ws://localhost:3001', ws: true },
      '/mcp': 'http://localhost:3001',
      '/.well-known': 'http://localhost:3001',
      '/oauth/token': 'http://localhost:3001',
      '/oauth/register': 'http://localhost:3001',
    },
  },
})
