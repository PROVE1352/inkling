// Word Stats — example Inkling plugin (command + notice + storage).
// Runs inside a sandboxed iframe; `inkling` is provided by the app's SDK. No network access.
/* global inkling */

const WORDS_PER_MINUTE = 200

/** Strip Markdown syntax that should not count as words. */
function plainText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, '$1') // wikilinks -> title
    .replace(/^[\s>*+\-#|:]+/gm, ' ') // list / heading / quote / table markers
    .replace(/[*_~]/g, '')
}

function stats(markdown) {
  const text = plainText(markdown)
  const words = (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) || []).length
  const chars = text.replace(/\s+/g, '').length
  return { words, chars, minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)) }
}

inkling.commands.register('count-words', async (ctx) => {
  if (!ctx.pageId) {
    await inkling.ui.notice('Open a page first.')
    return
  }
  try {
    const page = await inkling.pages.get(ctx.pageId)
    const s = stats(page.markdown)

    // Per-user storage: remember the last count for this page and show the difference.
    const key = `last:${page.id}`
    const prev = await inkling.storage.get(key)
    await inkling.storage.set(key, { words: s.words, at: new Date().toISOString() })
    const delta =
      prev && typeof prev.words === 'number' && prev.words !== s.words
        ? ` (${s.words - prev.words > 0 ? '+' : ''}${s.words - prev.words} since last count)`
        : ''

    await inkling.ui.notice(
      `${s.words.toLocaleString()} words${delta} · ${s.chars.toLocaleString()} characters · ~${s.minutes} min read`,
    )
  } catch (err) {
    await inkling.ui.notice(`Could not count words: ${err.message}`)
  }
})
