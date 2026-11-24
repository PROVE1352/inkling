/**
 * The "Contact" link to the operator (INSTANCE_CONTACT, docs/adr/2554-*). The server sends the finished
 * href (`/auth/mode` `instanceContact`) only after checking it; the screen still draws nothing for an
 * href that is not `mailto:` or `https:`, so a bad answer can never become a javascript: link.
 */
export interface ContactLink {
  href: string
  /** https: opens in a new tab (target=_blank, rel=noopener noreferrer); mailto: opens the mail app in place. */
  external: boolean
}

export function contactLink(href: string | undefined | null): ContactLink | null {
  if (typeof href !== 'string' || href === '' || /[\s\p{Cc}]/u.test(href)) return null
  if (/^mailto:[^@]+@[^@]+$/i.test(href)) return { href, external: false }
  if (/^https:\/\/[^/]/i.test(href)) return { href, external: true }
  return null
}

/** The anchor attributes for a contact link. */
export function contactLinkAttrs(link: ContactLink): { href: string; target?: '_blank'; rel?: string } {
  return link.external ? { href: link.href, target: '_blank', rel: 'noopener noreferrer' } : { href: link.href }
}
