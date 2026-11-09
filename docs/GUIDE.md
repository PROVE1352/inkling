# Inkling user guide

This guide is for people who use an Inkling server someone else runs. It answers "where is that feature?"
For installing and running a server, see [README.md](../README.md), [deploy/DEPLOY.md](../deploy/DEPLOY.md) and
[OPERATIONS.md](OPERATIONS.md). 한국어: [GUIDE.ko.md](GUIDE.ko.md).

Shortcuts are written for a Mac (⌘). On Windows and Linux use Ctrl; the [shortcut table](#keyboard-shortcuts)
lists both.

- [Getting started](#getting-started)
- [Writing](#writing)
- [Databases](#databases)
- [Graph, canvas and query blocks](#graph-canvas-and-query-blocks)
- [Tasks, due dates and calendar](#tasks-due-dates-and-calendar)
- [Working together](#working-together)
- [Sharing on the web](#sharing-on-the-web)
- [Edit lock](#edit-lock)
- [Connecting your AI (MCP)](#connecting-your-ai-mcp)
- [Importing from Notion](#importing-from-notion)
- [Export](#export)
- [Long pages: split into subpages](#long-pages-split-into-subpages)
- [Trash and version history](#trash-and-version-history)
- [Settings and the sidebar](#settings-and-the-sidebar)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Phone and tablet](#phone-and-tablet)
- [FAQ](#faq)

## Getting started

### Sign in

- **New account:** you need a signup key from the person who runs the server. Open the sign-in page, choose
  **Sign up with a signup key**, paste the key, and fill in your name, email and password (8+ characters).
- **Forgot your password:** **Forgot your password?** on the sign-in page. If you have a reset code, use
  **I have a code**. If not, **I don't have a code** sends a request: you get an email if the server sends mail,
  otherwise your admin sends you a code.
- The language follows your browser. Change it in Settings → Appearance → **Language**.

### Workspaces

A workspace is a shared space for a team. After your first sign-in you either **Create a workspace** or
**Join with an invite code**. An invite link (`…/join/<code>`) works too: open it while signed in and click **Join**.

The workspace name at the top of the sidebar opens the workspace menu: switch workspaces, **Members**,
**Workspace settings**, **New workspace**, **Join with code**, import and export.

Each workspace has two sections in the sidebar:

- **Shared**: every member can read and edit these pages.
- **Private** (🔒): only you can see them. They can't be published to the web or locked.

To move a page between them, open the right panel → Properties → **Move to private** / **Move to shared**.

Roles are **Owner**, **Admin** and **Member**. Owners change workspace settings; owners and admins publish pages to the web and manage edit locks.

### Making pages

- **New page** at the top of the sidebar, or ⌘N. The arrow (˅) next to it picks the type: **New document**,
  **New folder**, **New database**, **New canvas**, or **Start from template**.
- In the tree, hover a page and use **+** (Add subpage) or the **⋯** menu (right-click works too): Add subpage,
  Add subfolder, Add sub-database, Move to…, Duplicate, Rename, Add to favorites, Save as template and more.
- Drag pages in the tree to reorder or nest them.
- Where ⌘N puts the new page (top level, inside or next to the current page) is set in Settings →
  Files & links → **New page location**.
- **Today** in the sidebar opens today's daily note. The command palette (⌘P) also has yesterday's and
  tomorrow's.

### Finding things

- ⌘K: **Search** titles and content.
- ⌘O: **Quick switcher**, jump by title.
- ⌘P: **Command palette**, runs commands (new page, open trash, switch theme, switch workspace…) and jumps to pages.
- ☆ in the page header adds the page to **Favorites** at the top of the tree.

## Writing

### Slash menu and blocks

Type `/` in a document to insert a block: headings, lists, checklists, toggle lists, quotes, tables, code blocks,
images and files, and also:

- **Callout**: a highlighted box. Change its type (note, tip, warning, danger, info) from the icon in the block.
- **Math block** and **Inline math**.
- **Embed / link card**: paste a link (YouTube, Figma, Google Docs, …). Switch between embed, preview card and plain link.
- **Query**: a live list or table of pages (see below).

You can also drop images and files onto the page. The title is the large text at the top; F2 jumps to it.

### Math

- Display equation: `/` → **Math block**.
- Inline equation: type `$x^2$`, press ⌘⇧E (wraps the selection), or `/` → **Inline math**.
- Click an equation to edit its LaTeX with a live preview. Prices like `$5 and $10` stay text.

### Links, mentions and tags

- `[[` links to another page. Pick from the list or choose **＋ New page: "…"** to create it.
- `![[` embeds another page's content.
- `@` mentions a member (they are notified) or a page.
- `#tag` adds a tag. **Tags** in the sidebar lists every tag and its pages.
- Hovering an internal link shows a preview (Settings → Files & links → **Link preview**).

### Right panel

The panel button at the top right of a page opens the right panel: **Properties**, **Outline**, **Comments**,
**Backlinks**, **Unlinked mentions** (text that names this page but isn't linked yet), **Outgoing links**,
**Tags**, **Aliases**, **Local graph** and **History**. ⌘; jumps to the properties.

### Reading long pages

- **Outline in the margin**: a document with three or more headings shows a short line per heading at the right
  edge when the window is wide enough. Point at the lines to see the headings and click one to go there; the
  heading you are reading is the darker line. Turn it off in Settings → Editor → **Outline in the margin**.
- **Folding**: point at a top-level heading and click the arrow left of it to fold everything up to the next
  heading of the same or a higher level. Click again to unfold. From the keyboard, ⌘. (Ctrl+.) folds or unfolds
  the section the cursor is in; from inside the section the cursor moves to its heading first. On a phone or
  tablet, tap a heading and an arrow appears at the end of its line; tap the arrow. A folded heading shows "…"
  after its text and keeps its arrow. Folds are remembered per page on this device only and never change the
  document, so others see it unfolded. A folded section opens by itself when the cursor moves into it (for
  example Enter at the end of the heading), when you jump to something inside it from the outline, a comment or
  a task, and when you press ⌘F (Ctrl+F): the browser's find can't see folded text and doesn't tell the page
  what you search for, so every fold on the page opens, not only the ones with a match. Pen mode and printing
  show the whole page. Headings nested inside other blocks don't fold.

### Pen mode

**Pen mode** in the page header's **⋯** menu lets you write and highlight on a document with a pen or finger.
Esc or **Done** leaves it. **Clear** erases all ink on the page, so it asks first: press it once and it turns into
**Clear all?** for three seconds; press again to erase. Ink is saved only after the page's ink has loaded; if it
can't load, a message says so, and nothing you draw is saved until it does.

## Databases

Create one with **New database**. Each row is a page; **Open row as a page** opens it in full.

- **Views:** Table, Board, Calendar, Gallery, Timeline. Add one with **New view** in the view tabs.
- **Properties:** Text, Number, Select, Multi-select, Date, Checkbox, Person, URL, Relation, Rollup.
  Add one with **Add a property**.
- **Sort & filter** sets sorting, filters and visible properties per view. Boards group by a select property.
- **Column width** in a table: drag the right edge of a column header. The width is saved on the view for everyone;
  double-click the edge to go back to the automatic width (←/→ also work on a focused edge). If you can't edit the
  database, the width changes on your screen only. Long text is cut with "…"; hover to see all of it.
- Wide boards and tables use the whole width of the page. **Full width** (the database's **⋯** menu in the sidebar)
  and the line width setting apply to databases too.
- **Relation** links rows to another database. Tick **Show on the related collection too (two-way)** to see the
  link from both sides. **Rollup** calculates over related rows (count, sum, average, min, max, earliest/latest
  date, percent checked, unique values).
- Paste cells from a spreadsheet, or use **Import CSV / Excel…**. **Export view as CSV** / **Export view as Excel**
  saves the current view.
- **Google Sheets sync…** mirrors a published sheet into a database (experimental, only if your server has it on).

### Row templates

A row template fills in a new row: its title, property values and body. Make one from **New row ▾ → New
template** or **⋯ → Row templates…** and edit it like a page. Property values can be relative: a date can be
**Today** or **Days after today**, a person can be **Person who adds the row**. The title and text can use
template variables such as `{{date}}` or `{{input:Topic|Weekly}}` ([TEMPLATES.md](TEMPLATES.md#row-templates)).

- **New row** uses the template marked **Default for new rows** (an empty row when there is none). **▾** picks
  another template or **Empty row** and opens the new row.
- The board's **+** in a column and the calendar's **+** on a day use the default template too, with the
  column's value or the day's date on top.
- Everyone who can see the database can use its templates; changing them needs edit access (an edit lock
  applies). Templates are not pages: they don't show up in search, links, the graph or the sidebar.

## Graph, canvas and query blocks

- **Graph** (⌘G): every page and its links. **Graph settings** has a title search, **Show orphans**, **Show tags**,
  **Color by top-level folder** and force sliders. The right panel shows a **Local graph** of the current page.
- **Canvas:** an infinite board compatible with Obsidian's `.canvas` format. Add text, page and link cards; drop
  images onto it. A document's **⋯** menu → **Expand into canvas** turns it into one.
  Canvases can't be shared on the web.
- **Query blocks:** `/` → **Query**, then write a Dataview-style query such as `LIST FROM #project` or
  `TABLE status FROM "Projects"`. Results update as pages change. Syntax: [QUERY.md](QUERY.md).
- **Templates:** **Start from template** creates a page or a whole structure. Save your own with
  **Save as template** in a page's **⋯** menu. Details: [TEMPLATES.md](TEMPLATES.md).

## Tasks, due dates and calendar

- A checklist item with a date becomes a task, e.g. `- [ ] Report 📅 2026-09-30` or `[due:: 2026-09-30]`.
- **Due** in the sidebar lists overdue, this week and the next 30 days. **Add a task…** adds one to the "Tasks" document.
- **Calendar** shows dated items by month or week. Click an empty day to add a task, a page or the daily note;
  drag items to another day.
- Settings → Connections → **Calendar subscription (iCal)** gives you a private link for Google Calendar, Apple Calendar or
  Outlook. Anyone with the link can read those items, so keep it to yourself.

## Working together

### Editing at the same time

Several people can edit the same document or canvas at once. You see their cursors, and the header shows who is
online and the connection state. Changes made offline merge when you reconnect.

### Comments

Open the right panel → **Comments**. **Comment on current block** attaches a thread to the block your cursor is
in; **New thread** starts one for the page. Use `@` to mention someone, **Reply** to answer and **Resolve** to close
a thread.

### Notifications

The bell at the top right holds notifications from all your workspaces. You are notified when someone:

- mentions you in a page or comment,
- replies in your thread,
- makes you a page owner or assigns you in a Person cell,
- edits a page you follow.

Mentions written by an AI agent arrive quietly (no badge or mail) and in the summary email.

### Following a page

**Page notifications** in the page header's **⋯** menu sets the level for that page:

- **Follow this page** or **Follow page and subpages**
- **Mentions only** (the default), **Nothing**, **Mute** (also silences mentions; only approval requests addressed to you get through)
- **Inherit** uses the parent page's or workspace's setting.
- **Daily summary when AI edits here** sends one summary a day of AI edits under the page.

Settings → **Notifications** lists everything you follow and sets email: **Email right away** for mentions,
replies and assignments, and a **Summary email** (daily or weekly). If the server has no mail set up,
notifications stay in the app.

### Activity

**Activity** in the sidebar lists recent changes by people and AI, newest first. Filter by who (people / AI),
app, member, page or kind of change, and open **Show changes** to see a diff.

### Members

Workspace menu → **Members** to see members, add people you already share another workspace with, and copy or
regenerate the invite link. **Copy invite link** is also at the bottom of the sidebar.

### People with access and guests

The page **Share** dialog has a **People** part above the web link. Here you give one person a level on
a page and everything under it:

| Level | Read | Comment | Edit | Manage who has access |
|---|---|---|---|---|
| Can view | yes | | | |
| Can comment | yes | yes | | |
| Can edit (members' default) | yes | yes | yes | |
| Full access (members only) | yes | yes | yes | yes |

- **Members**: everyone already has **Can edit** on shared pages. A level here replaces that for this page
  tree, lower ("Kim can only view the contracts") or higher (**Full access** lets them manage people there).
  Workspace owners and admins always have full access. Only people with full access to the page, owners and
  admins can change members' levels.
- **Guests** are people outside the workspace. Type their email address: an account on this server gets
  access at once; for an address without an account, Inkling sends an invitation (or shows a link to copy
  when the server has no mail set up). They must sign in or sign up with that same address to accept.
  Guests see only the pages shared with them and the pages under them: nothing else of the workspace,
  no search, graph, members list or settings. They can view, comment or edit (never manage people), and
  they get a **Guest** badge. Database pages don't open for guests yet.
- Who may invite guests is a workspace setting (Workspace settings › General › **Who can invite guests**):
  nobody, owners, owners and admins (the default), or members who can edit the page. Members never give more than they have.
- A level set on a parent page shows as inherited on the pages under it; change it on the parent.
- The edit lock still applies on top: a guest with **Can edit** cannot edit a locked page unless the lock
  allows it.

Workspace settings › Members › **Guests** lists every guest with their pages and levels; owners and admins can remove
several at once. A guest who joins the workspace becomes an ordinary member, and someone removed from the
workspace loses their page levels too. Guests use the web app only: their API tokens and AI connections
don't reach the workspaces where they are guests. If the workspace requires two-step verification, so does
every guest.

## Sharing on the web

Only workspace owners and admins can publish or stop sharing.

1. Click **Share** in the page header, or **Share…** in the tree's **⋯** menu.
2. **Publish to web**, then copy the link. Anyone with it can read the page without signing in. Nobody can edit
   through it.
3. Sharing a folder publishes every page in it, except private pages.
4. **Stop sharing** turns the link off.

**Web shares** in the sidebar lists everything published in the workspace. Private pages and canvases can't be
shared. Owners can turn public links off for the whole workspace in Workspace settings → **Public links**.

### Expiry and password

Before you click **Publish to web**, the same dialog lets you choose:

- **Expires**: **Never**, in 1, 7 or 30 days, or **On a date…** (the link works until the end of that day).
  The server's clock decides, not the visitor's. After that, visitors see "This link has expired" and
  nothing about the page.
- **Require a password** (4 characters or more). Visitors enter it once per link and are not asked again
  for 12 hours. Send it separately from the link. Repeated wrong guesses slow down further tries on that
  link and block the IP address that keeps guessing. A password-protected link shows no title or text in
  chat previews and is kept out of search engines.

For a link that is already public, **Change expiry** extends it or removes the expiry, and **Set password**,
**Change** and **Remove** manage the password. Changing the password asks everyone again, including people
who already opened the page. Expired links stay in **Web shares** (marked **Expired**) until you extend or
stop them. **Stop sharing** also clears the expiry and password; publishing again makes a new address.

Owners can set rules for new links in Workspace settings → **Public links**: **Default expiry for new
links** (pre-selected, the publisher can still change it) and **Require a password on public links** (new
links need one and it can't be removed). Neither changes links that already exist. Expiry and password
changes are in the audit log; the password itself is never stored in plain form or logged.

## Edit lock

An edit lock protects a page and everything under it. Others can still read and comment.

1. Open **Edit lock…** in the page header's **⋯** menu or in the tree's **⋯** menu.
2. Turn on **Lock this page and its subpages**.
3. Under **People**, choose **Only the owner and chosen editors** (add people with **Add editor…**) or
   **Everyone (restrict agents only)**.
4. Under **Agents (AI via MCP)**, choose **Same as their person**, **Comment only** or **Read only**. This applies
   to every member's agent, owners and admins included.

Workspace owners and admins can always edit locked pages. Only they or the page owner can change a lock.
Private pages can't be locked. Locked pages show **Locked** and are read-only for everyone else, including
database cells, canvas cards and properties.

The same dialog has **Agent instructions**: a locked page whose text AI agents read as the workspace's rules for
them (always, for matching pages, or only when asked by name).

## Connecting your AI (MCP)

Inkling has a built-in MCP server. An AI app such as Claude Code or claude.ai can read and write your notes as you.

### Connect

Find your server's address in Settings → Connections → **MCP server** (**Copy URL**). It looks like
`https://notes.example.com/mcp`.

**Claude Code**

```bash
claude mcp add --transport http inkling https://notes.example.com/mcp
```

Then run `/mcp` in Claude Code, choose `inkling` and authenticate. Your browser opens Inkling's consent screen.
Sign in if asked, pick the access level and click **Allow**.

If Claude Code runs on another machine over SSH, the "return to the app" button can't reach it. Use
**Copy command** on the consent screen and run that command in a terminal on that machine, within 5 minutes.

**claude.ai**

Settings → Connectors → **Add custom connector** → URL `https://notes.example.com/mcp` → Connect. Sign in in the
window that opens and click **Allow**. Leave the OAuth client ID and secret empty.

### Read only or read and write

The consent screen asks for one:

- **Read and write**: read, search, create, edit and comment on pages.
- **Read only**: read and search only. The app can't change anything.

To change it later, disconnect and connect again.

### What the AI can see

The same screen asks what the app may see:

- **Everything I can see**: every workspace you are a member of.
- **Only some workspaces**: tick the workspaces. The app doesn't see the others.
- **Only one page and the pages under it**: pick a page. The app sees that page and everything below it, and can
  create new pages only there. Workspace templates are not available to it.

You can change this later without reconnecting: Settings → Connections → **Manage connections** → **Change range**.
A link from a page in range to a page outside shows only the link text written in the page.

### What the AI can and can't do

It can:

- see the workspaces you are a member of, their shared pages and your own private pages,
- search, read pages or single sections, and follow what changed since last time,
- create pages, edit sections, add database rows, comment, reply, and resolve threads you started,
- move pages to the trash.

It can't:

- see other people's private pages or workspaces you aren't in,
- delete anything permanently (the trash keeps it),
- change edit locks, members, public links or admin settings,
- edit a locked page unless the lock allows it.

### "via" labels

Everything an AI does is recorded as **you (via app name)**, for example "Kim (via Claude)". You see it in version
history, comments and the Activity screen. Pages an AI created show **Written by AI (via …)**, and
pages it edited show the last AI edit. Before an AI replaces a whole page, a **Before AI edit** snapshot is saved.

### Managing connections

- **Manage connections** in Settings (or "Manage MCP connections" in the ⌘P palette) lists your apps.
  **Disconnect** stops access right away.
- Workspace owners and admins see every member's agents in Workspace settings → **Connected agents** and can block
  one for that workspace.
- AI agents receive page text marked as data, not as instructions. Pages with suspicious text show
  **Possible prompt-injection text**. This is a warning only and may be a false positive.

More: [MCP.md](MCP.md).

### API tokens for scripts

For scripts and `inklingctl`, make a personal API token on the same screen (**API tokens** → **New token**).
Give it a name, an expiry (30, 90 or 365 days, or never), read only or read and write, and the same range choice
as above. The token is shown once; copy it then. Send it as `Authorization: Bearer ink_pat_…`:

```sh
curl -H "Authorization: Bearer $INKLING_TOKEN" https://notes.example.com/api/workspaces
```

A token acts as you, inside its range. It can't manage tokens, connections, passwords, two-step verification,
members, public links, webhooks or admin settings: those stay in the signed-in web app. The list shows when and
from which address each token was last used; **Revoke** stops it at once. Changing or resetting your password
revokes every token (like disconnecting your AI apps). If a workspace requires two-step verification and your
account doesn't have it, tokens are refused in that workspace too. An instance admin can revoke a member's tokens
in Admin → Users.

## Importing from Notion

1. In Notion: Settings → Export (or ⋯ → Export on a page) → **Markdown & CSV**, with subpages included and
   folders created for subpages.
2. In Inkling: workspace menu → **Import from Notion (.zip)** → **Choose .zip**, and upload the file as it is.

Pages become documents, CSV databases become databases, images and files are uploaded, and equations become math.
Callouts arrive as quotes. A report shows what was imported and which links weren't found.

The same menu also has **Import (.md/.zip)** for Markdown files and **Import folder** for a folder of `.md` files.

## Export

- One page: **⋯** menu → **Export (.md)**, or **Export with subpages (.zip)**. Canvases export as `.canvas`.
- PDF: **Export as PDF** in the page header's **⋯** menu.
- Database: **Export view as CSV** / **Export view as Excel**.
- Whole workspace: workspace menu → **Export all (.zip)**. An owner may limit who can do this.
- **Send to Notion** in the **⋯** menu works only if your server is set up for it.

## Long pages: split into subpages

- A page that keeps growing (an experiment log, a journal) gets slow to open, save and search. The page's ⋯ menu →
  **Split into subpages…** cuts it at its headings: pick H1, H2 or H3, untick sections you want to keep, and each
  remaining heading becomes a subpage with everything under it. The page keeps a link to each subpage where its
  section was, and its version history keeps the page as it was. Comments move with their blocks, links to the
  page keep working, and people who have the page open see it change in place.
- **New entries** at the bottom of the same dialog decides where appends from AI agents and the API go: on the
  page itself (default), into one subpage per month (`2026-11`), or into a new subpage once the current one
  passes a size. Typing in the page is not affected.
- When something keeps appending to a large page of yours, you get one notification for it (once per page).

## Trash and version history

- Deleting a page moves it to the **Trash** (bottom of the sidebar). Open it to **Restore** a page or
  **Delete forever**.
- The trash keeps pages for 30 days unless an owner changed it (Workspace settings → General → **Keep trash for**).
- Settings → Files & links → **Confirm before deleting**: when off, pages go straight to the trash with an "Undo" toast.
- **History** in the right panel lists saved versions. **View all** opens **Version history**: preview a version,
  **Compare with current**, **Snapshot now** to save one yourself, or **Restore this version** (the current state
  is saved first).
- A deleted workspace can be restored by its owner from Settings → Account → **Deleted workspaces** for 30 days.

## Settings and the sidebar

Open Settings with ⌘, or **Settings** at the bottom of the sidebar. The sections (Account, Security, Notifications,
Editor, Sidebar, Files & links, Appearance, Connections, Keyboard shortcuts, About) are listed on the left and the
chosen one opens on the right; on a phone the list comes first and a section opens over it. Two-step verification is
under Security; the app version and a link to this guide are under About.

Saved to your account (the same on every device):

- **Account**: email verification, **Change password**, deleted workspaces.
- **Security** (two-step verification), **Notifications**, **Sidebar**, **Calendar subscription (iCal)**.
- **Language** (in the Appearance group).

Saved on this device only (marked **This device** next to the setting):

- **Editor**: line width (600–1200 px of body text or full; 700 px by default, the per-page "Full width" still wins), spell check, word count, outline in the margin.
- **Files & links**: page on launch, new page location, link preview, confirm before deleting.
- **Appearance**: theme (light, dark, system), zoom. The theme item in a document's ⋯ menu does the same.

### Sidebar menus

Settings → **Sidebar** chooses which of Search, Graph, Tags, Web shares, Due, Calendar, Activity and Today appear
at the top of the sidebar, and in what order (drag, or the ↑/↓ buttons, which appear when you hover
over a row or reach it with the keyboard). **Reset to default** restores them. You
can also right-click (or long-press) a menu → **Hide from sidebar**. Hidden menus still open from the ⌘P palette
and their shortcuts.

⌘\ hides or shows the whole sidebar. To make it wider or narrower, drag its right edge (200–480 px);
double-click the edge to go back to 260 px. With the edge focused, ←/→ change the width (Shift for bigger steps).
The width is kept on this device only.

## Keyboard shortcuts

Press `?` (outside a text field) to see this list in the app. Settings → Keyboard shortcuts shows it too, with a search
box.
Custom shortcuts aren't supported yet.

| Action | Mac | Windows / Linux |
|---|---|---|
| Search | ⌘K | Ctrl+K |
| Quick switcher (titles) | ⌘O | Ctrl+O |
| Full-text search | ⌘⇧F | Ctrl+Shift+F |
| Command palette | ⌘P | Ctrl+P |
| New page | ⌘N or ⌘⌥N | Ctrl+Alt+N |
| Back / Forward | ⌘⌥← / ⌘⌥→ | Alt+← / Alt+→ |
| Graph | ⌘G | Ctrl+G |
| Settings | ⌘, | Ctrl+, |
| Toggle sidebar | ⌘\ | Ctrl+\ |
| Move to trash (pages selected in the tree) | ⌘⌫ | Ctrl+Del or Del |
| Shortcut help | ? | ? |
| **Sidebar tree** | | |
| Move up / down | ↑ / ↓ | ↑ / ↓ |
| Collapse / expand | ← / → | ← / → |
| Open / toggle folder | Enter | Enter |
| Rename | F2 | F2 |
| Context menu | Right-click | Right-click |
| **Page** | | |
| Rename title (outside the tree) | F2 | F2 |
| Open properties panel | ⌘; | Ctrl+; |
| **Editor** | | |
| Block menu | / | / |
| Bold | ⌘B | Ctrl+B |
| Italic | ⌘I | Ctrl+I |
| Toggle checkbox | ⌘L | Ctrl+L |
| Inline math (wraps the selection) | ⌘⇧E or `$…$` | Ctrl+Shift+E or `$…$` |
| Delete current block | ⌘D | Ctrl+D |
| Fold / unfold the section at the cursor | ⌘. | Ctrl+. |
| Undo | ⌘Z | Ctrl+Z |

⌘L and ⌘D work only while the cursor is in a document. In a normal browser tab ⌘N may open a new window, so use ⌘⌥N.

## Phone and tablet

Inkling runs in the browser and can be installed as an app (PWA). Open your server in the browser and use its
install or "Add to Home Screen" option. The installed app opens in its own window without the address bar.

The page header keeps bookmark, share, who is online, the right panel and **⋯**; pen mode, edit lock, page
notifications, PDF and theme are in **⋯** (a dot on it means the page is locked or followed). On a narrow
screen share and the right panel move into **⋯** too.

## FAQ

**Who can see my pages?**
Shared pages: every member of the workspace. Private (🔒) pages: only you, and your own connected AI apps.

**Can I give someone read-only access?**
Yes: in the page's **Share** dialog give them **Can view** on that page (and its subpages), as a member or as
a guest ([People with access and guests](#people-with-access-and-guests)). An [edit lock](#edit-lock) and a
[read-only web link](#sharing-on-the-web) still work as before.

**Can someone outside the workspace edit one page?**
Invite them as a guest with **Can edit** on that page. They see only that page tree.

**I deleted a page by mistake.**
Open **Trash** at the bottom of the sidebar and **Restore** it. To get back an older version of the text, use
**History** in the right panel.

**Someone else changed my page. Who was it?**
**History** in the right panel and the **Activity** screen show who changed what, including AI edits ("via …").

**My AI app says the page is locked.**
The page has an edit lock that doesn't allow agents to edit. Ask the page owner or a workspace admin.

**I'm not getting emails.**
Check Settings → Notifications. If it says the server has no mail configured, notifications stay in the app.

**How do I leave a workspace?**
Workspace settings → **Danger zone** → **Leave workspace**. Your private pages there go to the trash. If you are
the only owner, transfer ownership first.
