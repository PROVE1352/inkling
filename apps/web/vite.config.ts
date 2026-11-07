import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Modules that are only ever loaded on demand (syntax-highlighting grammars/themes, xlsx import,
// KaTeX for pages with math — lib/katex.ts).
const LAZY_ONLY = [/[\\/]@shikijs[\\/]langs/, /[\\/]@shikijs[\\/]themes/, /[\\/]exceljs[\\/]/, /[\\/]katex[\\/](?!package\.json)/]

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
      },
      workbox: {
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
