# Save to Inkling — minimal browser extension (example)

A Manifest V3 extension with one toolbar button: it opens your Inkling server's “Save to Inkling”
window (`/clip`) with the current tab's title, address and selected text, the same window the
bookmarklet in **Settings › Connections › Web clipper** opens. Saving happens in that window, with
the browser's own sign-in; the extension stores only the server address.

Use it where a site's Content-Security-Policy blocks the bookmarklet. It is an example to load
unpacked; it is not published in any extension store and has no build step.

1. Chrome / Edge: open `chrome://extensions`, turn on Developer mode, **Load unpacked**, pick this folder.
2. The options page opens on the first click: enter the address you open Inkling at (for example
   `https://notes.example.com`).
3. Sign in to Inkling in the same browser, then click the toolbar button on any page.

Permissions: `activeTab` + `scripting` read the selected text of the tab you clicked on (nothing runs
on other tabs), `storage` keeps the server address.
