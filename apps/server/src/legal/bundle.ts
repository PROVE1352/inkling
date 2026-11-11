import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * The terms, privacy policy and sign-up texts an operator puts in LEGAL_DIR (restricted mode, 0.22,
 * docs/adr/2519-*). Read once at boot; a folder that does not have the shape below refuses to boot,
 * with the file and the reason.
 *
 *   terms.ko.md, terms.en.md, privacy.ko.md, privacy.en.md   (the ones the operator has; Markdown)
 *   signup.json                                              (required: the notice and the tick boxes)
 *
 * The version is the first 12 hex characters of a sha256 over the files above, in file-name order,
 * each as `name NUL content NUL`. Other files in the folder (a README, editor backups) are not part of
 * it and are not served; they are listed in `ignored` so the boot log can say so.
 */

export type LegalDocName = 'terms' | 'privacy'
export type LegalLocale = 'en' | 'ko'
export const LEGAL_DOC_NAMES: readonly LegalDocName[] = ['terms', 'privacy']
const LOCALES: readonly LegalLocale[] = ['en', 'ko']

/** Text in one or both languages (a missing language falls back to the other one). */
export type Localized = Partial<Record<LegalLocale, string>>

export interface LegalItem {
  id: string
  required: boolean
  label: Localized
  doc?: LegalDocName
  details?: Localized
}

export interface LegalBundle {
  dir: string
  version: string
  notice: Localized | null
  items: LegalItem[]
  /** The documents present, each in the languages the folder has. */
  docs: Partial<Record<LegalDocName, Localized>>
  /** Files that still contain a template placeholder ({{OPERATOR_NAME}} …), with the placeholders. */
  placeholders: { file: string; found: string[] }[]
  /** Files in the folder that are not part of the bundle. */
  ignored: string[]
}

export class LegalConfigError extends Error {
  constructor(file: string, reason: string) {
    super(`LEGAL_DIR: ${file}: ${reason}`)
    this.name = 'LegalConfigError'
  }
}

/** Placeholders of the demo templates (deploy/demo/legal). Left in a served file = boot warning. */
export const TEMPLATE_PLACEHOLDERS = ['{{OPERATOR_NAME}}', '{{CONTACT_EMAIL}}', '{{SERVICE_URL}}', '{{EFFECTIVE_DATE}}'] as const

const DOC_FILE = /^(terms|privacy)\.(ko|en)\.md$/
const SIGNUP_FILE = 'signup.json'
/** Item ids are what the sign-up body carries (registerSchema: 1–64 characters, at most 32). */
const ITEM_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/
const MAX_ITEMS = 32
const MAX_LABEL = 1000
const MAX_DETAILS = 20_000
const MAX_DOC_BYTES = 512 * 1024

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function localized(v: unknown, where: string, max: number): Localized {
  if (!isRecord(v)) throw new LegalConfigError(SIGNUP_FILE, `${where} must be an object with "ko" and/or "en" text`)
  const out: Localized = {}
  for (const [k, text] of Object.entries(v)) {
    if (k !== 'ko' && k !== 'en') throw new LegalConfigError(SIGNUP_FILE, `${where} has an unknown language "${k}" (use "ko" and "en")`)
    if (typeof text !== 'string') throw new LegalConfigError(SIGNUP_FILE, `${where}.${k} must be text`)
    const trimmed = text.trim()
    if (!trimmed) throw new LegalConfigError(SIGNUP_FILE, `${where}.${k} is empty`)
    if (trimmed.length > max) throw new LegalConfigError(SIGNUP_FILE, `${where}.${k} is longer than ${max} characters`)
    out[k] = trimmed
  }
  if (!out.ko && !out.en) throw new LegalConfigError(SIGNUP_FILE, `${where} is empty (give "ko", "en" or both)`)
  return out
}

function parseSignup(raw: string, docs: LegalBundle['docs']): { notice: Localized | null; items: LegalItem[] } {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new LegalConfigError(SIGNUP_FILE, `not valid JSON (${(err as Error).message})`)
  }
  if (!isRecord(json)) throw new LegalConfigError(SIGNUP_FILE, 'must be a JSON object with "items"')
  for (const k of Object.keys(json)) {
    if (k !== 'notice' && k !== 'items') throw new LegalConfigError(SIGNUP_FILE, `unknown key "${k}" (allowed: notice, items)`)
  }
  const notice = json.notice === undefined ? null : localized(json.notice, 'notice', MAX_LABEL)
  if (!Array.isArray(json.items)) throw new LegalConfigError(SIGNUP_FILE, '"items" must be a list')
  if (json.items.length > MAX_ITEMS) throw new LegalConfigError(SIGNUP_FILE, `more than ${MAX_ITEMS} items`)
  const seen = new Set<string>()
  const items: LegalItem[] = json.items.map((it: unknown, i: number) => {
    const where = `items[${i}]`
    if (!isRecord(it)) throw new LegalConfigError(SIGNUP_FILE, `${where} must be an object`)
    for (const k of Object.keys(it)) {
      if (!['id', 'required', 'label', 'doc', 'details'].includes(k)) {
        throw new LegalConfigError(SIGNUP_FILE, `${where} has an unknown key "${k}" (allowed: id, required, label, doc, details)`)
      }
    }
    if (typeof it.id !== 'string' || !ITEM_ID.test(it.id)) {
      throw new LegalConfigError(SIGNUP_FILE, `${where}.id must be 1-64 characters of a-z, 0-9, "_", "." or "-", starting with a letter or digit`)
    }
    if (seen.has(it.id)) throw new LegalConfigError(SIGNUP_FILE, `${where}.id "${it.id}" is used twice`)
    seen.add(it.id)
    if (typeof it.required !== 'boolean') throw new LegalConfigError(SIGNUP_FILE, `${where}.required must be true or false`)
    const item: LegalItem = { id: it.id, required: it.required, label: localized(it.label, `${where}.label`, MAX_LABEL) }
    if (it.doc !== undefined) {
      if (it.doc !== 'terms' && it.doc !== 'privacy') throw new LegalConfigError(SIGNUP_FILE, `${where}.doc must be "terms" or "privacy"`)
      if (!docs[it.doc]) throw new LegalConfigError(SIGNUP_FILE, `${where}.doc is "${it.doc}" but the folder has no ${it.doc}.ko.md or ${it.doc}.en.md`)
      item.doc = it.doc
    }
    if (it.details !== undefined) item.details = localized(it.details, `${where}.details`, MAX_DETAILS)
    return item
  })
  return { notice, items }
}

/** Read and check LEGAL_DIR. Throws LegalConfigError (file and reason) when the folder is not usable. */
export function loadLegalDir(dir: string): LegalBundle {
  let names: string[]
  try {
    if (!statSync(dir).isDirectory()) throw new LegalConfigError(dir, 'is not a folder')
    names = readdirSync(dir).sort()
  } catch (err) {
    if (err instanceof LegalConfigError) throw err
    throw new LegalConfigError(dir, `cannot be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`)
  }
  const parts = names.filter((n) => DOC_FILE.test(n) || n === SIGNUP_FILE)
  const ignored = names.filter((n) => !parts.includes(n))
  if (!parts.includes(SIGNUP_FILE)) throw new LegalConfigError(SIGNUP_FILE, 'missing (the folder needs signup.json)')

  const hash = createHash('sha256')
  const contents = new Map<string, string>()
  for (const name of parts) {
    const file = path.join(dir, name)
    let buf: Buffer
    try {
      if (!statSync(file).isFile()) throw new LegalConfigError(name, 'is not a file')
      buf = readFileSync(file)
    } catch (err) {
      if (err instanceof LegalConfigError) throw err
      throw new LegalConfigError(name, `cannot be read (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`)
    }
    if (buf.length > MAX_DOC_BYTES) throw new LegalConfigError(name, `larger than ${MAX_DOC_BYTES / 1024} KB`)
    const text = buf.toString('utf8')
    if (name !== SIGNUP_FILE && !text.trim()) throw new LegalConfigError(name, 'is empty')
    hash.update(name).update('\0').update(buf).update('\0')
    contents.set(name, text.replace(/^﻿/, ''))
  }

  const docs: LegalBundle['docs'] = {}
  for (const doc of LEGAL_DOC_NAMES) {
    for (const loc of LOCALES) {
      const text = contents.get(`${doc}.${loc}.md`)
      if (text !== undefined) (docs[doc] ??= {})[loc] = text
    }
  }
  const { notice, items } = parseSignup(contents.get(SIGNUP_FILE) ?? '', docs)

  const placeholders: LegalBundle['placeholders'] = []
  for (const [name, text] of contents) {
    const found = TEMPLATE_PLACEHOLDERS.filter((p) => text.includes(p))
    if (found.length) placeholders.push({ file: name, found })
  }

  return { dir, version: hash.digest('hex').slice(0, 12), notice, items, docs, placeholders, ignored }
}

/** The text in `locale`, else the other language (a one-language folder serves everyone). */
export function pick(text: Localized, locale: LegalLocale): string {
  return text[locale] ?? text[locale === 'ko' ? 'en' : 'ko'] ?? ''
}

/** Which language `pick` actually returns for `locale`. */
export function pickedLocale(text: Localized, locale: LegalLocale): LegalLocale {
  return text[locale] !== undefined ? locale : locale === 'ko' ? 'en' : 'ko'
}

/** Boot log lines for a loaded bundle (version, documents, and anything the operator should fix). */
export function describeBundle(b: LegalBundle): { info: string[]; warn: string[] } {
  const docList = LEGAL_DOC_NAMES.filter((d) => b.docs[d]).map((d) => `${d} (${Object.keys(b.docs[d] ?? {}).sort().join(', ')})`)
  const info = [
    `[inkling] LEGAL_DIR ${b.dir}: version ${b.version}, ${b.items.length} consent items (${b.items.filter((i) => i.required).length} required), documents: ${docList.join(', ') || 'none'}`,
  ]
  const warn: string[] = []
  for (const p of b.placeholders) {
    warn.push(`[inkling] LEGAL_DIR: ${p.file} still contains template placeholders ${p.found.join(', ')}; fill them in before people sign up`)
  }
  if (b.ignored.length) warn.push(`[inkling] LEGAL_DIR: ignoring files that are not part of the documents: ${b.ignored.join(', ')}`)
  return { info, warn }
}
