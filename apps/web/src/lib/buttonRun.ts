// Button block runs (docs/adr/2244-*): the actions of a button, in order, as the person who pressed
// it, through the REST routes that person may use anyway. Kept out of React (and out of api.ts) so
// it runs under plain Node tests: every request, field lookup and navigation is injected.
import { isOpenableUrl, renderTextVars, resolveActionProps } from '@inkling/shared'
import type { ActionVarContext, ButtonAction, CollectionField } from '@inkling/shared'

/** Requests the runner makes (the app passes `api`). Rejects with an Error whose message is shown. */
export type ButtonRequest = <T>(path: string, init: { method: 'POST' | 'PATCH'; body: string }) => Promise<T>

export interface ButtonRunDeps {
  request: ButtonRequest
  /** Fields of a collection (definition only: `GET /pages/:id/collection?rows=0`). */
  loadFields: (collectionId: string) => Promise<CollectionField[]>
  /** Open a page of the workspace (SPA navigation). */
  openPage: (pageId: string) => void
  /** Open an http(s) URL (new tab). Only called with URLs that pass `isOpenableUrl`. */
  openUrl: (url: string) => void
  /** IANA time zone sent with new rows ('today' in templates); optional. */
  tz?: string
}

export interface ButtonRunInput {
  /** The page the button block is in (null: not known — page-bound actions fail). */
  pageId: string | null
  /** The collection that page is a row of (null: the page is not a row). */
  rowCollectionId: string | null
  /** The button block's id (the server finds the webhook action in it). */
  blockId: string
  /** Variables: today, who pressed, this page. */
  ctx: ActionVarContext
}

/** Failures the runner itself detects (the UI translates them); server errors carry their own message. */
export type ButtonRunErrorCode = 'notRow' | 'noPage' | 'badUrl' | 'nothingToOpen'

export class ButtonRunError extends Error {
  code: ButtonRunErrorCode
  constructor(code: ButtonRunErrorCode) {
    super(code)
    this.name = 'ButtonRunError'
    this.code = code
  }
}

export type ButtonRunResult =
  | { ok: true; done: number; collections: string[] }
  | {
      ok: false
      /** Actions that ran before the failure. */
      done: number
      /** 0-based index of the action that failed (nothing after it ran). */
      failedIndex: number
      failedType: ButtonAction['type']
      /** Set for failures the runner detects; otherwise `message` holds the server's text. */
      code: ButtonRunErrorCode | null
      message: string
      collections: string[]
    }

/** YYYY-MM-DD in the browser's local time zone ('today' of a button means the presser's day). */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

async function runOne(
  a: ButtonAction,
  input: ButtonRunInput,
  deps: ButtonRunDeps,
  fieldsOf: (id: string) => Promise<CollectionField[]>,
  collections: Set<string>,
): Promise<void> {
  const { ctx } = input
  switch (a.type) {
    case 'addRow': {
      const fields = await fieldsOf(a.collectionId)
      const props = resolveActionProps(fields, a.props, ctx)
      const title = a.title ? renderTextVars(a.title, ctx).trim() : ''
      const body: Record<string, unknown> = {}
      // undefined → the collection's default template; null → an empty row
      if (a.templateId !== undefined) body.template = a.templateId
      if (title) body.title = title
      if (Object.keys(props).length) body.props = props
      if (deps.tz) body.tz = deps.tz
      await deps.request(`/api/pages/${a.collectionId}/collection/rows`, { method: 'POST', body: JSON.stringify(body) })
      collections.add(a.collectionId)
      return
    }
    case 'setFields': {
      if (!input.pageId || !input.rowCollectionId) throw new ButtonRunError('notRow')
      const fields = await fieldsOf(input.rowCollectionId)
      const props = resolveActionProps(fields, a.props, ctx)
      if (!Object.keys(props).length) return
      await deps.request(`/api/pages/${input.pageId}/props`, { method: 'PATCH', body: JSON.stringify({ props }) })
      collections.add(input.rowCollectionId)
      return
    }
    case 'open': {
      if (a.pageId) return deps.openPage(a.pageId)
      if (a.url === undefined || a.url.trim() === '') throw new ButtonRunError('nothingToOpen')
      // The block's JSON is written by anyone who can edit the page: check the URL again here
      // (the schema accepts any string), never hand `javascript:` or the like to the browser.
      if (!isOpenableUrl(a.url)) throw new ButtonRunError('badUrl')
      return deps.openUrl(a.url.trim())
    }
    case 'webhook': {
      if (!input.pageId) throw new ButtonRunError('noPage')
      await deps.request(`/api/pages/${input.pageId}/button-webhook`, {
        method: 'POST',
        body: JSON.stringify({ blockId: input.blockId, webhookId: a.webhookId }),
      })
      return
    }
  }
}

/**
 * Runs the actions in order and stops at the first failure: nothing after the failing action runs.
 * `collections` lists the collections written to (for cache refreshes), also after a failure.
 */
export async function runButtonActions(actions: ButtonAction[], input: ButtonRunInput, deps: ButtonRunDeps): Promise<ButtonRunResult> {
  const cache = new Map<string, Promise<CollectionField[]>>()
  const fieldsOf = (id: string) => {
    let p = cache.get(id)
    if (!p) {
      p = deps.loadFields(id)
      cache.set(id, p)
    }
    return p
  }
  const collections = new Set<string>()
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    try {
      await runOne(a, input, deps, fieldsOf, collections)
    } catch (e) {
      return {
        ok: false,
        done: i,
        failedIndex: i,
        failedType: a.type,
        code: e instanceof ButtonRunError ? e.code : null,
        message: e instanceof Error ? e.message : String(e),
        collections: [...collections],
      }
    }
  }
  return { ok: true, done: actions.length, collections: [...collections] }
}

/** One run at a time per button: a press while a run is going is ignored (double clicks, Enter held). */
export function createRunGuard() {
  let busy = false
  return {
    get busy() {
      return busy
    },
    /** Runs `fn` unless a run is going; resolves to null when the press was ignored. */
    async run<T>(fn: () => Promise<T>): Promise<T | null> {
      if (busy) return null
      busy = true
      try {
        return await fn()
      } finally {
        busy = false
      }
    },
  }
}
