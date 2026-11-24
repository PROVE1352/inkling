import type { SectionProvenanceDTO } from '@inkling/shared'
import type { RevertSource } from '../components/RevertDialog'
import { fmtRelative, t } from '../i18n'

// Section marks (docs/adr/1627-*): the small "who changed this section last" sign next to a
// heading. Pure helpers: the person's initials, the label and tooltip of a mark, which marks are
// shown, and the change handed to the revert dialog.

const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯豈-﫿]/

/**
 * Initials for a person's mark: the first letters of the first two words ("Kim Yuna" → "KY"), the
 * first two letters of a single word ("kyuchan" → "KY"), one character for a CJK name ("김규찬" →
 * "김"), "?" for an empty name.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  const first = Array.from(words[0])
  if (CJK.test(first[0])) return first[0]
  const out = words.length > 1 ? first[0] + Array.from(words[1])[0] : first.slice(0, 2).join('')
  return out.toLocaleUpperCase()
}

export interface MarkLabel {
  kind: 'agent' | 'person'
  /** Agent: the client name (cut by CSS); person: initials. */
  short: string
  /** Tooltip: "{name} via {client} · {when}" or "{name} · {when}". */
  title: string
}

export function markLabel(item: SectionProvenanceDTO, now: number = Date.now()): MarkLabel {
  const name = item.actor?.name ?? t('activity.someone')
  const when = fmtRelative(item.changedAt, now)
  const title = item.via ? t('sectionMark.titleVia', { name, client: item.via, when }) : t('sectionMark.title', { name, when })
  if (item.agent && item.via) return { kind: 'agent', short: item.via, title }
  return { kind: 'person', short: initials(name), title }
}

/**
 * Which marks are drawn (decision 2 of the 0.23 contract): every section whose newest change has a
 * known actor, people and agents alike, placed by its heading block; one per block.
 */
export function visibleMarks(items: SectionProvenanceDTO[]): SectionProvenanceDTO[] {
  const seen = new Set<string>()
  const out: SectionProvenanceDTO[] = []
  for (const it of items) {
    if (!it.actor || !it.blockId || seen.has(it.blockId)) continue
    seen.add(it.blockId)
    out.push(it)
  }
  return out
}

/** What the popover says instead of the revert button, or null when the button is offered. */
export function revertBlocker(item: SectionProvenanceDTO): 'reverted' | 'moved' | 'tooLarge' | null {
  if (item.revertedBy) return 'reverted'
  if (item.revertable) return null
  return item.kind === 'moved' ? 'moved' : 'tooLarge'
}

/** The change as the revert dialog takes it (scope 'change' first). */
export function toRevertSource(item: SectionProvenanceDTO, pageId: string, pageTitle?: string | null): RevertSource {
  return {
    seq: item.seq,
    pageId,
    pageTitle: pageTitle ?? null,
    headingPath: item.headingPath,
    via: item.via,
    actor: item.actor,
    changedAt: item.changedAt,
    isRevert: item.isRevert,
  }
}
