// Synthetic Notion "Markdown & CSV" export used by the Notion importer tests (docs/adr/0960-*).
// Everything here is made up: hashed names, a nested part archive, two CSV databases with row
// folders and a relation, percent-encoded links, an image, a PDF, a callout, a toggle, an equation.
import JSZip from 'jszip'

/** Deterministic fake Notion ids (32 lower-case hex digits). */
export const H = {
  wiki: '1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a',
  start: '2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b',
  notesA: '3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c',
  notesB: '4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d',
  projects: '5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e',
  alpha: '6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f',
  beta: '70707070707070707070707070707070',
  people: '81818181818181818181818181818181',
  roadmap: '92929292929292929292929292929292',
  missing: 'a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3',
}

const enc = (s: string) => encodeURIComponent(s)
const WIKI = `Team Wiki ${H.wiki}`
const START = `Getting Started ${H.start}`
const PROJECTS = `Projects ${H.projects}`
const ROADMAP = `로드맵 계획 ${H.roadmap}`

/** 1x1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

export const FIXTURE_FILES: Record<string, string | Buffer> = {
  [`${WIKI}.md`]: `# Team Wiki\n\nWelcome.\n\n[Getting Started](${enc(WIKI)}/${enc(START)}.md)\n\n[Projects](${enc(WIKI)}/${enc(PROJECTS)}.csv)\n`,
  [`${WIKI}/${START}.md`]: [
    '# Getting Started',
    '',
    '<aside>',
    '💡 Read this first.',
    '</aside>',
    '',
    '<details>',
    '<summary>More info</summary>',
    'Hidden details here.',
    '</details>',
    '',
    '| Col A | Col B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '- [ ] Set up account',
    '- [x] Read the wiki',
    '',
    '$$',
    'E = mc^2',
    '$$',
    '',
    'Inline math $a_1 + b$ here, prices $5 and $10 stay.',
    '',
    `![diagram 1.png](${enc(START)}/${enc('diagram 1.png')})`,
    '',
    `[spec sheet.pdf](${enc(START)}/${enc('spec sheet.pdf')})`,
    '',
    `See [Notes](${enc(`Notes ${H.notesA}`)}.md), the [wiki home](../${enc(WIKI)}.md), ` +
      `the [projects](${enc(PROJECTS)}.csv), the [roadmap](https://www.notion.so/acme/Roadmap-${H.roadmap}) ` +
      `and a [missing page](${enc(`Missing Page ${H.missing}`)}.md).`,
    '',
    `[Alpha](${enc(PROJECTS)}/${enc(`Alpha ${H.alpha}`)}.md)`,
    '',
    '```js',
    'const price = "$5 and $6"',
    '```',
    '',
  ].join('\n'),
  [`${WIKI}/${START}/diagram 1.png`]: PNG,
  [`${WIKI}/${START}/spec sheet.pdf`]: Buffer.from('%PDF-1.4\n% synthetic\n'),
  [`${WIKI}/Notes ${H.notesA}.md`]: '# Notes\n\nFirst notes page.\n',
  [`${WIKI}/Notes ${H.notesB}.md`]: '# Notes\n\nSecond notes page with the same title.\n',
  // the view export (fewer columns) and the full table: only _all is used
  [`${WIKI}/${PROJECTS}.csv`]: '﻿Name,Status\nAlpha,Active\n',
  [`${WIKI}/${PROJECTS}_all.csv`]:
    '﻿Name,Status,Tags,Due,Done,Budget,Website,Contact,Lead,Members\n' +
    'Alpha,Active,"web, api","November 7, 2026",Yes,"$1,200",https://example.com/alpha,alpha@example.com,Pat Doe,"Ada, Linus"\n' +
    'Beta,Done,web,"November 9, 2026 3:00 PM → November 12, 2026",No,300,https://example.com/beta,beta@example.com,Sam Roe,Ada\n' +
    'Gamma,Active,"api, data",2026/11/20,No,50,,gamma@example.com,Pat Doe,\n' +
    'Delta,Done,data,"@December 1, 2026",Yes,0,https://example.com/delta,,Sam Roe,Linus\n',
  [`${WIKI}/${PROJECTS}/Alpha ${H.alpha}.md`]:
    '# Alpha\n\nStatus: Active\nTags: web, api\nDone: Yes\n\nAlpha is the first project.\n\n- [ ] Ship v1 📅 2026-11-30\n',
  [`${WIKI}/${PROJECTS}/Beta ${H.beta}.md`]: '# Beta\n\nStatus: Done\n\nBeta notes.\n',
  [`${WIKI}/People ${H.people}_all.csv`]:
    '﻿Name,Projects,Role\n' +
    `Ada,"Alpha (${enc(PROJECTS)}/${enc(`Alpha ${H.alpha}`)}.md), Beta (${enc(PROJECTS)}/${enc(`Beta ${H.beta}`)}.md)",Engineer\n` +
    `Linus,"Alpha (${enc(PROJECTS)}/${enc(`Alpha ${H.alpha}`)}.md)",Designer\n`,
  // Korean name stored NFD (as macOS zips do); the link to it is a notion.so URL
  [`${ROADMAP}.md`.normalize('NFD')]: `# 로드맵 계획\n\n[시작하기](${enc(WIKI)}/${enc(START)}.md)\n`,
}

/** Expected numbers for the fixture (asserted by the tests). */
export const FIXTURE_EXPECT = {
  documents: 5, // Team Wiki, Getting Started, Notes, Notes (2), 로드맵 계획
  collections: 2,
  rows: 6, // Projects: Alpha, Beta, Gamma, Delta; People: Ada, Linus
  attachments: 2,
  links: { total: 11, resolved: 10 },
  broken: 1,
}

/**
 * Builds the export the way Notion ships a large one: an outer zip holding part archives.
 * With `nested: false` the files sit directly in one zip.
 */
export async function buildNotionFixture(opts: { nested?: boolean } = {}): Promise<Buffer> {
  const entries = Object.entries(FIXTURE_FILES)
  const pack = async (list: [string, string | Buffer][]) => {
    const z = new JSZip()
    for (const [name, data] of list) z.file(name, data)
    return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  }
  if (opts.nested === false) return pack(entries)
  const half = Math.ceil(entries.length / 2)
  const outer = new JSZip()
  outer.file('Export-0f0f0f0f-0000-4000-8000-000000000001-Part-1.zip', await pack(entries.slice(0, half)))
  outer.file('Export-0f0f0f0f-0000-4000-8000-000000000001-Part-2.zip', await pack(entries.slice(half)))
  return outer.generateAsync({ type: 'nodebuffer' })
}
