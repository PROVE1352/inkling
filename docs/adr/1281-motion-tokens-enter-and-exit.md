# 1281. Motion: one easing set, enter and exit animations, tree reveal

- Status: Accepted
- Date: 2026-11-08

## Context
Animations existed (`.nd-pop`, `.nd-enter`, drawers; ADR 1222 for the page fade) but each used plain `ease-out`
with its own duration, nothing animated on close (menus, modals and toasts vanished in the frame they closed),
the tree's arrow swapped icons, and BlockNote's slash menu popped in. The constraints: transform and opacity
only, 120–220 ms, everything instant under `prefers-reduced-motion`, nothing that changes with scrolling gets a
transition (ADR 1220: a 200 ms colour transition on the margin outline took scroll p95 from 18 to 34 ms), and no
animation inside editor blocks (ADR 0850: a block whose layout lags its DOM lost typed characters).

## Decision
- **Tokens** (index.css): `--ease-out: cubic-bezier(0.22, 1, 0.36, 1)` for everything that appears or changes
  state, `--ease-in: cubic-bezier(0.4, 0, 1, 1)` for exits (a steeper ease-in, 0.55/0/1/0.45, kept a closing menu at 91 % opacity halfway and then dropped it: read as a lag), `--ease-in-out` for symmetric moves;
  `--dur-fast` 120 ms (exits, presses), `--dur-base` 180 ms (entrances), `--dur-slow` 220 ms (drawers, sheets,
  tree). Tailwind's `--default-transition-timing-function` is the same curve, so every `transition*` utility
  shares it; existing `duration-150` classes stay.
- **Scale through the `scale` / `translate` properties**, not `transform`, so it composes with floating-ui's
  inline `transform`, Tailwind's translate utilities, and the `origin-*` utility that sets where a menu grows
  from. The motion classes are unlayered and never set `transform-origin`.
- **Menus, popovers, dropdowns, context menus** (`.nd-pop`): opacity 0 → 1 and scale 0.97 → 1 in 180 ms from
  the trigger side (`origin-top-right` for ⋯ menus, `origin-top-left` for context menus and the callout menu).
  **Slash menu and BlockNote dropdowns** get the same through CSS on `.bn-suggestion-menu` / `.bn-menu-dropdown`
  (SlashMenu.tsx untouched). Verified that the suggestion menu stays the same element while filtering (`/he`:
  0 remounts), so it plays once per opening. The formatting toolbar is not animated (it follows the selection).
- **Modals** (`.nd-dialog`): backdrop fade, body scale + fade; at < 640 px the body rises 24 px instead.
- **Toasts and the update banner** (`.nd-toast`): rise 12 px with a fade; leave with a 120 ms fade.
- **Exits** (`.nd-out`: 120 ms, `--ease-in`, no pointer events): `lib/motion.ts` `usePresence(open)` keeps an
  element mounted for `EXIT_MS` (= `--dur-fast`) after it closed, 0 under reduced motion. Used by Modal,
  ConfirmDialog, ConfirmPopover, the tree row's ⋯ and context menus, and the tree's child list. Modal and
  ConfirmDialog show the last content they rendered open while leaving (a caller that clears its state in
  `onClose` does not flash empty content) and ignore Esc and backdrop clicks. The toast store marks a dismissed
  toast `leaving` and removes it 120 ms later.
- **Sidebar tree**: the arrow is one chevron turned 90° (`rotate`, 180 ms). The child list opens by growing its
  grid row from `0fr` to `1fr` (220 ms, with a fade) and closes the same way in 120 ms; the clip (`overflow:
  hidden`) is animated as a discrete value, so it exists only while moving and never cuts focus rings or drop
  lines afterwards. While closing, the list reuses the elements of its last open render: a collapse changes the
  `expand` prop of every row, and re-rendering 400 rows only to fade them out cost ~25 ms at the click.
- **Press**: buttons scale to 0.98 while held (base layer, zero specificity, no transition added). Not on
  full-width rows, menu items, options, tabs, tree rows, anything in `.bn-container`, the margin outline or the
  fold arrows (B's scroll-driven elements, ADR 1220/1221).
- **Toggle switch, checkbox, hover and selection backgrounds** keep their 150 ms colour/transform transitions,
  now on the shared curve.
- **Reduced motion**: every new class is listed with the existing ones under `animation: none`; transitions
  were already cut to 0.01 ms; `usePresence` and the toast store skip the exit delay.
- **Unchanged**: the page fade (0.15 s opacity, ADR 1222), drawers (now 220 ms, same movement), editor blocks.

## Alternatives
- **An animation library** (Framer Motion and similar): a dependency for what CSS keyframes and one 30-line
  hook do (ADR 0882).
- **Exit on every menu in the app**: about 20 ad-hoc menus close through local state; each needs the presence
  hook and cached positions. Done for the shared ones; the rest close instantly as before and open animated.
- **Height animation with measured `max-height`**: needs a JS measurement per open and a guessed maximum for
  large folders; `grid-template-rows` 0fr → 1fr needs neither. Measured on a 1,000-item tree: no difference in
  click-to-frame or frame times against the same build with the old fade (PERFORMANCE.md).
- **Animating the formatting toolbar or editor blocks**: rejected (selection-driven; ADR 0850).

## Consequences
- A Modal whose caller unmounts it on close (`{open && <XModal/>}`) still disappears at once; only callers that
  keep `<Modal open={…}>` mounted get the exit.
- 120 ms after closing, a menu or modal is still in the DOM with `aria-hidden` (modals) and no pointer events;
  tests that assert absence right after a close must wait for it.
- Tree rows have one more state hook each (child list presence) plus two for their menus.
