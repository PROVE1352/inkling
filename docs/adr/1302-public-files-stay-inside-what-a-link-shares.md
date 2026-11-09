# 1302. Public links serve only files of pages inside what they share

- Status: Accepted
- Date: 2026-11-09

## Context
A public link serves `/api/public/:token/f/:fileId` (single page, or a folder's own icon/cover) and
`/api/public/:token/p/:ref/f/:fileId` (a page inside a shared folder). The gate is: the file is
referenced by the public page (blocks, cover, icon), belongs to the same workspace, and its own page
is live and shared (docs/adr/0811-*, C-L11). The last check ignored the link's scope: an editor of a
shared page could paste the `/files/<id>` URL of an attachment on any other shared page of the
workspace, and the link would publish that attachment to anyone, although the other page was never
shared on the web.

## Decision
- The file's own page must be inside what the link shares: the page itself for a single-page link,
  the folder or a page of its current subtree for a folder link (`fileOwnerPageIsPublic(pageId,
  sharedIds)` in `routes/public.ts`). Otherwise 404, like any other file the gate refuses.
- Files without a page (`files.page_id IS NULL`, uploads from before pages owned files) keep only
  the reference gate, as before.

## Alternatives considered
- Require the file's page to have its own public link: a folder link would stop serving images
  that live on its subpages.
- Copy a referenced attachment to the public page when it is pasted: a write on read paths, and it
  would not fix links that exist already.

## Consequences
- A shared page that shows an image uploaded to another page outside the link loses that image on
  the public page (the in-app view is unchanged). Re-uploading the image on the shared page fixes it.
  Duplicating a page, creating a page from a template and moving or copying blocks do not copy
  `files` rows: the copy points at the original page's attachments, so a duplicated page shared on
  its own shows no images unless the original is inside the same link (docs/KNOWN-ISSUES.md). Giving
  copies their own file rows is the follow-up.
- Tests: `accessLeaks.db.test.ts` ("public links serve only files of pages inside what they share"),
  `shareLinks.db.test.ts` unchanged.
