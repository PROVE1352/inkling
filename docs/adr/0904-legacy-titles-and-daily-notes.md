# 0904. Localized names for app-created pages, and daily-note titles stay ISO dates

- Status: Accepted
- Date: 2026-11-07

## Context
Some pages are found by title: the private daily-notes folder (`데일리`), the workspace task
document that quick-add appends to (`할 일`), and daily notes themselves, which the server and the
calendar recognise by a title that is exactly `YYYY-MM-DD` (`md/dateItems.ts`, `lib/dailyNote.ts`).

## Decision
- Folder and document names are created in the creator's language (`Daily`/`데일리`,
  `Tasks`/`할 일`). Lookups accept the localized name and the legacy names in both languages, so
  an existing Korean workspace keeps using its folder/document instead of getting a second one
  after a user switches to English.
- Daily-note titles stay ISO `YYYY-MM-DD` in every language. The title is the key the calendar,
  due view and server indexers match on; a localized title ("November 7, 2026") would need a
  separate date property and a migration of existing notes. The UI shows the date localized where
  it renders it as a label.

## Trade-offs
Two members using different languages in one workspace may see an English-named and a
Korean-named folder each in their own private section; shared documents are found under either
name.
