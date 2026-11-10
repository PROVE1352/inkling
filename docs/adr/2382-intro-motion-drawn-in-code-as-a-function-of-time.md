# 2382. The intro motion is SVG drawn in code as a pure function of time, in a lazy chunk

- Status: Accepted (extended by [ADR 2385](2385-intro-end-screen-camera-and-ink-wipe.md) in 0.19.1: new scenes, a camera, ink wipes, the end screen; the viewBox and size figures below are 0.19.0's)
- Date: 2026-11-11

## Context
New accounts get a 20–30 second introduction (notes and links, databases and views, agents over MCP
with suggestions and undo, self-hosting and offline). It must be skippable, pausable, keyboard and
screen-reader friendly, still for `prefers-reduced-motion`, readable on a phone, in both themes, without
sound, without making the entry bundle or the service worker precache bigger, and reusable later to
render a promo video frame by frame.

## Decision
- **Scenes as pure functions** (`onboarding/intro/scenes.ts`): `renderIntroFrame(t, copy, { frame })`
  returns SVG markup for time `t` (seconds). No clock, random source, DOM, CSS animation or SMIL; the
  hand-drawn wobble is a seeded hash of the element and `floor(t·6)`. Four scenes of 6.5 s (26 s).
  The "ink drop" (the logo's accent node) is one path through all scenes (`dropAt(t)`, eased keys).
- **Two frames from the same function**: `art` (viewBox 200 110 1560 720, captions shown as HTML
  under it so they stay readable at 390 px) and `full` (1920×1080 with the captions drawn in the
  frame) for export.
- **Colors and type**: only `var(--color-*)` tokens and `var(--font-sans)` (tool names in the system
  monospace); light and dark follow the app theme. AI clients are named in text only.
- **Player** (`IntroOverlay.tsx`): owns the clock (`requestAnimationFrame`, dt capped at 0.1 s), a modal
  dialog (`aria-modal`, focus kept inside, captions in `aria-live`, the picture as `role="img"` with a
  per-scene description), Skip, Pause/Play, Previous/Next, one dot per scene, Esc / ← → / Space
  captured before the editor's shortcuts. Reduced motion: no clock; each scene is its still
  (`STILL_TIMES`) and the arrows turn slides.
- **Frame driving without the clock**: while the dialog is open,
  `window.__inklingIntro = { duration, seek(t), stage(on), play(), pause(), scene() }`; `stage(true)`
  shows the full frame at exactly 1920×1080 CSS px at the top left.
- **Loading**: the intro is its own chunk under `assets/lazy/` (a `LAZY_ONLY` pattern in
  `vite.config.ts`, outside the VitePWA block), so it is not precached and is cached on first use.
  `onboarding/Host.tsx` fetches it with a plain `import()`; a failure (offline before it was ever
  cached) skips the intro and leaves it "not seen", instead of the stale-chunk reload route chunks do.
- **Copy** lives in `i18n/{en,ko}/onboarding.ts` (`intro.*`); the player builds the `IntroCopy` object
  from it.

## Alternatives considered
- **A video file.** Megabytes in the image and in every client that plays it, a second asset per
  language and theme, and no reduced-motion or screen-reader version for free.
- **CSS keyframes or SMIL.** Run on the wall clock: no seek, no frame-exact export, and pausing and
  reduced motion would need a second implementation.
- **Canvas.** Text and theming by hand, and no DOM for screen readers; SVG strings are small enough to
  replace each frame.
- **An animation library.** A new dependency (ADR 0882) for easing and a timeline that fit in a few
  helpers.

## Trade-offs
- The SVG is rebuilt every frame (about 10–20 KB of markup); fine for a 26 s modal, not for a
  permanent background animation.
- On a phone the picture is small; the captions carry the meaning.

## Consequences
- Lazy chunk `assets/lazy/IntroOverlay-*.js` about 20.6 KB (7.6 KB gzip); entry and precache change are
  in the PR notes.
- `scenes.test.ts`: length, determinism, no clock or random source, tokens only, captions only in the
  full frame, two caption lines at most in both languages.
