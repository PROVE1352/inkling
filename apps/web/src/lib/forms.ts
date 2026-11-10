/**
 * Form views on the web (docs/adr/1820-*): the questions a form shows, for members (from the view's
 * settings and the collection's fields) and for visitors (from the public form DTO), and the check
 * before sending. The check is the shared `formSubmissionProps`, the one the server runs again.
 */
import { FORM_TITLE_FIELD, formFields, formSubmissionProps } from '@inkling/shared'
import type { CollectionField, FieldType, FormProblem, FormSettings, PublicFormDTO, SelectOption } from '@inkling/shared'

export interface FormQuestion {
  key: string
  name: string
  type: FieldType | 'title'
  required: boolean
  description: string
  options?: Pick<SelectOption, 'id' | 'name' | 'color'>[]
}

/** The questions of a member form, in order. `titleName` labels the row title question. */
export function memberQuestions(settings: FormSettings | undefined, fields: CollectionField[], titleName: string): FormQuestion[] {
  return formFields(settings, fields, { public: false }).map((q) => ({
    key: q.fieldId,
    name: q.field ? q.field.name : titleName,
    type: q.field ? q.field.type : 'title',
    required: q.required,
    description: q.description,
    ...(q.field?.options ? { options: q.field.options } : {}),
  }))
}

/** Field list and settings rebuilt from a public form (to run the shared check in the browser). */
export function publicFormModel(dto: PublicFormDTO): { settings: FormSettings; fields: CollectionField[] } {
  const fields: CollectionField[] = []
  for (const q of dto.fields) {
    if (q.type === 'title') continue
    fields.push({ id: q.key, name: q.name, type: q.type, ...(q.options ? { options: q.options } : {}) })
  }
  return {
    settings: { fields: dto.fields.map((q) => ({ fieldId: q.key, required: q.required })) },
    fields,
  }
}

export function publicQuestions(dto: PublicFormDTO): FormQuestion[] {
  return dto.fields.map((q) => ({
    key: q.key,
    name: q.name,
    type: q.type,
    required: q.required,
    description: q.description,
    ...(q.options ? { options: q.options } : {}),
  }))
}

/** Problems before sending (the server decides again); empty = ready to send. */
export function formProblems(
  settings: FormSettings | undefined,
  fields: CollectionField[],
  values: Record<string, unknown>,
  isPublic: boolean,
): Record<string, FormProblem> {
  return formSubmissionProps(settings, fields, values, { public: isPublic }).problems
}

/** Questions the editor can still add: the title and eligible properties not asked yet. */
export function addableQuestions(settings: FormSettings | undefined, fields: CollectionField[], eligible: (t: FieldType) => boolean): string[] {
  const asked = new Set((settings?.fields ?? []).map((q) => q.fieldId))
  const out: string[] = []
  if (!asked.has(FORM_TITLE_FIELD)) out.push(FORM_TITLE_FIELD)
  for (const f of fields) if (eligible(f.type) && !asked.has(f.id)) out.push(f.id)
  return out
}

/** Move question `i` up (-1) or down (+1); out-of-range moves leave the list as it is. */
export function moveQuestion(settings: FormSettings, i: number, dir: -1 | 1): FormSettings {
  const j = i + dir
  if (j < 0 || j >= settings.fields.length) return settings
  const next = [...settings.fields]
  ;[next[i], next[j]] = [next[j], next[i]]
  return { ...settings, fields: next }
}
