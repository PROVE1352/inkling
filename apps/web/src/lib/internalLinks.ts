// Clicks on links inside editor bodies (the page editor, row templates, page-embed bodies).
//
// Internal page links (`/w/…`, section links `#h=…` included) are drawn as
// `<a href="/w/…" target="_blank">`. A plain click moves inside the app (React Router); a click with
// ⌘/Ctrl/Shift/Alt or the middle button opens a new tab, as for any link. External links open one
// new tab.
//
// Two code paths see the same click in an editable editor: BlockNote's link click plugin
// (`links.onClick`, on mouseup — by default it calls window.open(href, '_blank') for every link,
// which opened a second tab next to the in-app move) and the click event, where the app navigates.
// The browser itself does not follow links inside contenteditable (no click, middle click or
// ⌘-click), so in an editable body the app opens the new tab; in a read-only body (editable=false,
// or the read-only embed viewer inside an editable page) the browser does.
import type { MouseEvent as ReactMouseEvent } from 'react'

/** The in-app path of an internal page link (same origin, under `/w/`), or null. */
export function internalLinkPath(href: string | null | undefined, origin: string): string | null {
  if (!href) return null
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return null
  }
  if (url.origin !== origin || !url.pathname.startsWith('/w/')) return null
  return `${url.pathname}${url.search}${url.hash}`
}

type ClickLike = { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }

/** A primary click without modifiers: the only click the app turns into an in-app move. */
export function isPlainClick(e: ClickLike): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
}

function linkOf(target: EventTarget | null): HTMLAnchorElement | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  return el?.closest<HTMLAnchorElement>('a[href]') ?? null
}

function openInNewTab(a: HTMLAnchorElement) {
  window.open(a.href, '_blank', 'noopener,noreferrer')
}

/**
 * BlockNote's `links.onClick` (editable editors, primary button only). Returns true so BlockNote's
 * default window.open never runs; opens the new tab itself only where the browser will not.
 */
export function editorLinkClick(event: MouseEvent): boolean {
  const a = linkOf(event.target)
  if (!a) return false
  // a read-only island inside the editor (page-embed body): the browser follows the link itself
  if (!a.isContentEditable) return true
  // a plain click on an internal link: the click handler below moves inside the app
  if (internalLinkPath(a.getAttribute('href'), window.location.origin) && isPlainClick(event)) return true
  openInNewTab(a)
  return true
}

/**
 * Click (capture phase) on an editor body: a plain click on an internal link moves inside the app.
 * Returns true when it did (the caller may stop the event from reaching an outer body).
 */
export function internalLinkClick(e: ReactMouseEvent, navigate: (path: string) => void): boolean {
  if (e.defaultPrevented || !isPlainClick(e)) return false
  const a = linkOf(e.target)
  const path = internalLinkPath(a?.getAttribute('href'), window.location.origin)
  if (!path) return false
  e.preventDefault()
  navigate(path)
  return true
}

/** Middle click (auxclick) on a link in an editable body: the browser does nothing there, so open the tab. */
export function editableLinkAuxClick(e: ReactMouseEvent) {
  if (e.button !== 1) return
  const a = linkOf(e.target)
  if (!a || !a.isContentEditable) return
  e.preventDefault()
  openInNewTab(a)
}
