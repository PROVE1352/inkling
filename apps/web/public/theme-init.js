// Dark-mode FOUC guard: apply the theme class before React mounts. Kept as an external file (not an
// inline <script>) so the app shell can run under `script-src 'self'` (docs/adr/0852-*).
try {
  var t = localStorage.getItem('inkling-theme')
  var dark =
    t === 'dark' ||
    ((t === null || t === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches)
  if (dark) document.documentElement.classList.add('dark')
} catch (e) {}
