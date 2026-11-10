# 2385. The intro ends on a screen of next steps; a camera and ink wipes inside the same pure function

- Status: Accepted
- Date: 2026-11-11

## Context
The 0.19.0 intro (ADR 2382) was seen in production and found thin: grey bars instead of content, one
fixed wide shot per scene with fades between them, a separate database scene that any notes app could
show, and an ending that closed the dialog with nothing to do next. It also called Inkling "open
source" in a line that onboarding does not need. The frame has to stay a pure function of t (the promo
video renders it frame by frame), light and dark, readable at 390 px, still for reduced motion, and in
a lazy chunk.

## Decision
- **Scenes** (still 4 × 6.5 s): notes written together, with the database view inside the page turning
  from a table into a board; an agent reading (find_context picks two sections, not pages, and the answer
  cites them as `Page › Heading`); the agent editing while a person decides (a section replacement
  suggested, reviewed and accepted, the "Before AI edit" point that accepting it saves (ADR 0930) with
  Revert, then update_row moving a board card); your own server (sync,
  offline, synced, the logo). Words come from i18n, colours from the theme tokens and the select option
  colours. Things the app does not show are not drawn (no "AI" badge on rows; update_row gets no
  version dot, it is not an AI step; the suggestion is a replacement because accepting an append saves no
  undo point).
- **Camera**: each scene is drawn in its own 1920×1080 world; `CAMS` holds 4–6 keys per scene (a
  rectangle to fit and a focus point), eased in and out. The player measures the picture's box and passes
  `aspect`; a frame narrower than 1.3 shows at most 700 world units across, centred on the focus point, so
  a phone gets a close shot with readable words instead of the whole scene shrunk.
- **Transitions**: the drop leaps out at the end of a scene, falls into the next one, squashes where it
  lands, and the next scene is revealed through a wobbly accent blob that grows from there (an SVG
  `clipPath` whose radius is a function of t). The scene before is held on its last frame under it.
- **The drop**: one path of keys per scene in world coordinates (`dropAt(t)`), hops along arcs, a short
  tail while it moves, stretched along its motion, squashed on landing, two eyes that look where it goes
  and blink; it ends as the logo's first node. One protagonist per scene is a rough boiling sketch for
  0.3 s before it settles.
- **End screen**: when the clock runs out (or after the last reduced-motion slide) the dialog stays open
  under the picture's last frame (the logo) with the tagline, "Ready to write?" and buttons: Open/Make the
  sample page (new accounts only: the checklist is not dismissed), New page (the sidebar's rule in
  `lib/newPage.ts`), Connect an AI agent (Settings › Connections with the checklist's bubble), Close.
  Buttons that cannot work there (no workspace, a guest) are not drawn. A button closes the intro (seen)
  first and then acts; the creating ones use `mutateAsync` so they finish after the dialog is gone, and a
  failure is a toast. Focus goes to the first button; → stays, ← goes back to scene 4, Esc closes.
- **Compatibility**: `renderIntroFrame(t, copy, { frame })` and `dropAt(t)` keep their shape (`aspect` is
  an optional addition); `window.__inklingIntro.seek(duration)` shows the last picture and never the end
  screen, which is HTML outside the SVG. `IntroCopy` is now `{ scenes, w }` with `w` keyed by
  `INTRO_WORDS`.

## Alternatives considered
- **Close by itself at the end, as in 0.19.0.** The end is the moment the person knows what Inkling does
  and has nothing to press; a "Get started" button that only closed was not a next step.
- **The end screen drawn in the SVG.** Buttons need focus, Tab order and screen-reader names; HTML gives
  them, and the promo render keeps a clean last frame.
- **Fades between scenes, a wide shot per scene.** Cheaper, but the 16:9 scene shrunk to a phone's width
  was unreadable and the scenes did not connect.
- **SVG filters (feTurbulence) for the sketch look, as the promo film does.** Expensive to repaint every
  frame on a phone; two jittered outlines read the same at this size.
- **A database scene of its own (table → board → calendar).** It showed what every notes app does; the
  database now lives inside the notes scene and comes back as something an agent changes.

## Trade-offs
- The chunk grew from 20.6 kB (7.5 kB gzip) to 34.7 kB (13.5 kB gzip); the longer copy also sits in the
  i18n chunk that the entry preloads.
- On a phone the camera shows part of a scene at a time; the words drawn in the picture are about 12–16 px.
- The 0.8 s reading rule is tested on the markup (every completed string present for 0.8 s at 0.05 s
  steps), not on what the camera has in view.
- The promo video's own camera, eyes and wipes now overlap what the module draws; the film needs a new
  shot list before it is rendered from this module again.

## Consequences
- `scenes.test.ts`: purity with and without `aspect`, a phone frame is closer, the last frame is the logo,
  only allowed colour tokens, the 0.8 s rule, no "open source" in the intro or card copy.
- Chrome checks: the onboard check gained the end screen (stops, buttons per account, focus, keys,
  reduced motion, 390 px, no "open source" in ko and en); the legacy check gained the end screen of an
  existing account (no sample; AI and New page work; not shown again).
