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
- [Slack](#slack)
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
- **Chart**: a chart of a database or a query (see [Charts](#charts)).

**Tables**: type a row such as `| Name | Role | Due |` on an empty line and press Enter: it becomes a table with
that header row and an empty row to fill in (⌘Z right after turns it back into text). `/table 3x4` inserts an
empty table of 3 columns × 4 rows (`/표 3x4` and `3*4` work too). A Markdown table pasted as text becomes a table.

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

### Verifying a page

Mark a page as checked and correct until a date: **⋯** → **Verify page…** → choose 30, 90 or 180 days or **Until a
date…** (at most a year), add a note if you like, then **Mark verified**. A badge under the title says "Verified
until …". After the date it turns into **Needs verification**. The badge also shows how many sections changed since
it was verified. People who can edit the page can verify it; when the page has an owner, only the owner or a
workspace owner or admin. **All verified pages** lists the pages that need verification, the ones that expire within
7 days and the verified ones. Connected AI agents see the mark too, and are told when a page is out of date.

### Presenting a page

**⋯** → **Present** (also on a shared page) shows a document as full-screen slides. Each top-level heading starts a
slide, and a divider also ends one. Move with ← / → (or PageUp / PageDown, Space, Home / End) or swipe; Esc leaves.
The slides are a copy of the page when you opened them: edits made meanwhile show after you open it again.

### Pen mode

**Pen mode** in the page header's **⋯** menu lets you write and highlight on a document with a pen or finger.
Esc or **Done** leaves it. **Clear** erases all ink on the page, so it asks first: press it once and it turns into
**Clear all?** for three seconds; press again to erase. Ink is saved only after the page's ink has loaded; if it
can't load, a message says so, and nothing you draw is saved until it does.

AI agents you connect do not see your handwriting unless the workspace allows it. An owner or admin can turn on
**Agents can read handwriting** in Workspace settings → **Connected agents**. Then an agent can ask for a picture of a
page's pen and highlighter strokes when it needs them; it still reads the page text the usual way. It is off by
default, and turning it off again takes effect at once.

## Databases

Create one with **New database**. Each row is a page; **Open row as a page** opens it in full.

- **Views:** Table, Board, Calendar, Gallery, Timeline, Chart, Form. Add one with **New view** in the view tabs.
- **Properties:** Text, Number, Select, Multi-select, Date, Checkbox, Person, URL, Relation, Rollup, Formula.
  Add one with **Add a property**.
- **Sort & filter** sets sorting, filters and visible properties per view. Boards group by a select property.
- **Keyboard** in a table: click a cell or Tab into the table, then move with the arrows, Tab / ⇧Tab and Home / End.
  Enter or F2 edits the cell (or opens its list or ticks its checkbox); in a text cell Enter saves and moves down,
  Esc cancels. Space ticks a checkbox, ⌫ clears the selected cells, ⇧+arrows extend the selection for ⌘C / ⌘V,
  ⌘Enter adds a row and opens its title (so does Enter on the last row), ⌘⇧Enter opens the row as a page. Without
  edit rights the keys only move. The keys are in the shortcut list under *Database table* and can be changed there.
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

### Charts

Type `/chart` and pick the data: a database (all rows, or the rows one of its views shows) or a
query. Then choose the kind of chart, what to group by and what to count. Dates can be grouped by
day, week or month. "Split by" adds a second grouping, drawn as grouped or stacked bars or several
lines. "Value" counts rows, or sums, averages or finds the smallest or largest value of a number
property.

A chart keeps only its settings. Everyone who opens the page sees the numbers of the rows they are
allowed to see, and a chart whose database you cannot open says so instead of showing numbers. When
someone edits the database, the chart redraws within about 20 seconds (at once for your own edits).

A database can also be shown as a chart: add a view and choose **Chart**. The view's filters decide
which rows are counted.

In Markdown exports a chart becomes a table of its numbers. On a public link, a chart shows a table
only when its database is inside the shared folder.

### Forms

A form collects answers into a database: each answer becomes a row. Add a view and choose **Form**, then **Edit
form**: pick the questions (the title and text, number, select, multi-select, date, checkbox, URL and person
properties), put them in order with **Move up** / **Move down**, tick **Required**, and add a **Help text** under a
question. You can also set the form's title, description, **Button text** and the **Message after sending**. Members
fill the form in the app.

**Public link** (owners and admins): **Turn on public link** and copy it. Anyone with the link can send answers
without signing in; they never see the rows or other people's answers. Person and relation questions are left out
of the public form. **Turn off** stops the link at once. The link also closes by itself when the database is trashed
or made private, when public links are turned off for the workspace, or when the person who turned it on can no
longer add rows. Answers show up in Activity as "<that person> via public form" and count as people's input, not
as AI edits.

### Formulas

A **Formula** property computes a value from the same row; you can't type into it. Write the expression when you add
the property, for example:

- `prop("Price") * prop("Qty")`
- `if(prop("Done"), "✓", "")`
- `dateBetween(prop("Due"), now(), "days")`

| Function | What it does |
|---|---|
| `prop("Name")` | The value of a property of the same row (`"Title"` is the row title). Select gives the option name, multi-select the names joined with ", ", checkbox true or false; person and relation are empty |
| `if(cond, a, b)` | `a` when `cond` is true (not empty, not zero), else `b` |
| `and(a, b, …)`, `or(a, b, …)`, `not(a)` | Logic; the words `and`, `or`, `not` and `&&`, `\|\|`, `!` work too |
| `concat(a, b, …)` | The text of every argument joined |
| `length(x)` | Number of characters of the text of `x` (empty is 0) |
| `round(n, digits)` | Rounded to 0–10 digits (`digits` is optional) |
| `min(a, …)`, `max(a, …)` | Smallest / largest number; empty values are skipped |
| `abs(n)` | Absolute value |
| `now()` | The current date and time |
| `dateAdd(date, n, unit)` | The date moved by `n` units: `years`, `months`, `weeks`, `days`, `hours`, `minutes` |
| `dateBetween(a, b, unit)` | `a` minus `b` in whole units |

Operators: `+` (adds numbers; with text it joins), `-`, `*`, `/`, `%`, `=`, `!=`, `<`, `<=`, `>`, `>=`. Text goes in
quotes. Dates are computed in UTC. A cell with a problem shows the error instead of a value (circular reference,
division by zero, a property that doesn't exist, …). Formulas follow when you rename a property. You can filter,
sort, group and chart by a formula like by any other property, and exports contain its values.

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
online and the connection state. Changes made while the connection is down merge when you reconnect, as long as
the tab stays open: Inkling keeps nothing in the browser's storage.

While some of your edits have not reached the server, the connection dot turns amber and reads **Not saved yet**
(hover it for "Some edits have not reached the server yet. Keep this tab open until they are saved."). Closing or
reloading the tab then asks you first. Opening another page inside the app is fine: the edits of the page you left
are kept until the server has them.

### Comments

Open the right panel → **Comments**. **Comment on current block** attaches a thread to the block your cursor is
in; **New thread** starts one for the page. Use `@` to mention someone, **Reply** to answer and **Resolve** to close
a thread.

### Notifications

The bell at the top right holds notifications from all your workspaces. You are notified when someone:

- mentions you in a page or comment,
- replies in a comment thread you follow (see *Following a comment thread*),
- makes you a page owner or assigns you in a Person cell,
- edits a page you follow.

A reminder you set on your Later list also arrives there when it comes due.

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

### Following a comment thread

When you start a comment thread or reply in one, you follow it: replies by others reach your bell (and your
email, by your settings). **Follow thread** / **Following** on a thread card in the comments panel follows or
stops following any thread, including ones you never wrote in. An unfollow sticks even if you reply again.

**Threads** in the sidebar lists the threads you follow that have new replies, newest first, with how many
replies are new and the last one. Opening a thread there marks it read, and the bell item for that thread
too. Check **Show threads without new replies** to see every thread you follow (for example to unfollow).

Settings → **Notifications** has two switches: **Follow threads I start or reply in** (off: you only follow
by hand) and **Notify me about replies in threads I follow** (off: replies only show under Threads, no badge
or mail; mentions still notify you).

### Later

**Save for later** keeps a page, a comment thread or a notification on your **Later** list (sidebar):

- a page: **⋯** menu → **Save for later**, or *Save this page for later* in the ⌘P palette
- a thread: the clock button on its card in the comments panel
- a notification: the clock button on the item in the bell

The same dialog sets a **reminder**: in 20 minutes, this evening (18:00), tomorrow 9:00, next Monday 9:00,
or a date and time you pick. Times are your device's local time. When the time comes you get a bell item
(and an email if you get email right away); the sidebar shows how many reminders are due. Mark items
**Done** (they move to the Done tab) or remove them. If you lose access to a saved page (it was made
private, you left the workspace, or the workspace now needs two-step verification), the item stays on
your list without its title, and its reminder is not sent.

Connected AI agents can read your Later list (the `later` tool) but cannot add to it or set reminders.

### Activity

**Activity** in the sidebar lists recent changes by people and AI, newest first. Filter by who (people / AI),
app, member, page or kind of change, and open **Show changes** to see a diff. Changes made through an agent have
**Revert** (see [Reverting agent edits](#reverting-agent-edits)).

### Members

Workspace menu → **Members** to see members, add people you already share another workspace with, and copy or
regenerate the invite link. **Copy invite link** is also at the bottom of the sidebar.

### Your status

Settings → **Account** → **Status** → **Set status**: pick an emoji, write a short message ("Exam week, back
Friday") and choose when it clears: **In an hour**, **Today**, **This week**, **At a date and time…** or **Don't
clear**. Your status shows next to your name in the members list, the `@` mention menus and on the avatars of people
online on a page (the page header). It is the same in every workspace. AI agents see it when they mention you or assign you a row.

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

### Scheduling a start

A public link can start working later. Before you click **Publish to web**, turn on **Schedule a start** and pick
the date and time (in your device's time zone). Until then the link answers like a link that doesn't exist. Once
published, the dialog says **Opens …** with **Change start** and **Open now**, and **Web shares** marks the link.
Changing the start is in the audit log.

## Edit lock

An edit lock protects a page and everything under it. Others can still read and comment.

1. Open **Edit lock…** in the page header's **⋯** menu or in the tree's **⋯** menu.
2. Turn on **Lock this page and its subpages**.
3. Under **People**, choose **Only the owner and chosen editors** (add people with **Add editor…**) or
   **Everyone (restrict agents only)**.
4. Under **Agents (AI via MCP)**, choose **Workspace default**, **Edit directly**, **Accept by rules**,
   **Suggestions only**, **Comment only** or **Read only**. This applies to every member's agent, owners and admins
   included. **Workspace default** follows the workspace's [agent edit setting](#how-agents-edit);
   **Suggestions only** turns every agent edit into a suggestion a person reviews. With **Accept by rules** the
   dialog also shows the auto-accept rules for this page and the pages under it.

Workspace owners and admins can always edit locked pages. Only they or the page owner can change a lock.
Private pages can't be locked. Locked pages show **Locked** and are read-only for everyone else, including
database cells, canvas cards and properties.

The same dialog has **Agent instructions**: a locked page whose text AI agents read as the workspace's rules for
them (always, for matching pages, or only when asked by name).

## Slack

A workspace owner can connect the workspace to Slack: Workspace settings → **Slack**. The page lists the steps,
the addresses and a ready-made app manifest to paste in Slack; the full procedure is in
[OPERATIONS.md](OPERATIONS.md), section 6. The owner picks a channel and which updates it gets: mentions,
assignments, AI suggestions waiting for review, comment replies and a daily summary of changed pages. **Send test
message** checks the setup.

- Only pages shared with the whole workspace appear in Slack. Private pages and other workspaces never do.
- Work someone hands to a person's AI agent (see [Team agents](#team-agents)) is not posted to the channel.
- Type `/inkling <words>` in Slack to search your own notes; only you see the answer, and it shows only what you
  can see in Inkling. `/inkling help` lists the commands.
- If `/inkling` says your account is not linked (your Slack email differs from your Inkling email), type
  `/inkling link` and open the link while signed in to Inkling. `/inkling unlink` removes the link.
- Paste an Inkling page link in Slack to show its title and first paragraph (shared pages only).

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
- search, read pages or single sections, follow what changed since last time, and get a summary of what happened
  while it was away,
- create pages, edit sections (or only suggest an edit for you to review), add database rows and create databases,
  comment, reply, and resolve threads you started,
- look through a page's version history, compare two versions and bring an older one back (the version it replaces is
  kept, so you can undo it),
- move pages to the trash, look in the trash and restore a page from it,
- open attachments: images and text files, and the name and size of other files such as PDFs,
- see your handwriting, only where the workspace allows it.

It can't:

- see other people's private pages or workspaces you aren't in,
- delete anything permanently (the trash keeps it) or empty the trash,
- accept or reject suggestions (people do that),
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
  one for that workspace. For each agent they also see how many calls it made in this workspace, about how many
  tokens of text it got back, how many failed and how many were answered from the cache. The numbers count from the
  last server start; Inkling keeps only the numbers, never what was asked or returned. Server admins see the same for
  every agent connection and API token in Admin → **Server status**.
- If an agent follows your notes as they change, tell it to call `changes_since` with `wait`: it then waits for the
  next change instead of asking again every few seconds.
- AI agents receive page text marked as data, not as instructions. Pages with suspicious text show
  **Possible prompt-injection text**. This is a warning only and may be a false positive.

More: [MCP.md](MCP.md).

### Search by meaning (server admins)

By default the AI finds sections by the words in them. A server admin can also let it search by meaning: then a
question finds a section written in other words, and a Korean question can find an English page. Set
`EMBEDDING_URL` (an OpenAI-compatible embeddings API, for example a local Ollama at `http://host:11434/v1`) and
`EMBEDDING_MODEL` in the server's `.env` and restart. The server then sends the text of the notes to that service in
the background, so pick one on your own network if notes must not leave it. Admin → **Server status** shows how
many sections are indexed and the last error. To turn it off, remove the two variables and restart. Details:
[OPERATIONS.md](OPERATIONS.md), section 5.

### Reviewing what agents suggest

Agents can leave a change for you to review instead of writing it: when you ask them to, when the workspace is set to
review agent edits (see below), or when the page is locked with **Suggestions only**. A line above the page says how
many suggestions are waiting, and each section with a suggestion has a small "✎ N suggested" marker next to its
heading. **Review** shows every suggestion as a diff against the text as it is now. **Accept** applies it as you,
**Reject** drops it; either way the agent that made it finds the answer in its inbox. If someone changed the section
after the agent read it, the dialog says so and asks you to confirm with **Accept anyway**. Only people who can edit
the page can accept or reject; the page owner gets a notification for each new suggestion.

A suggestion that replaces a section is shown as numbered changes, one per block, and you can take only some of them.
Checked changes are applied when you click **Apply selected**; a change marked **Overlaps an edit** touches a block
someone changed after the agent read the section. It is unchecked and shows what is there now; checking it replaces
that text with the agent's version. Everything else people wrote stays.

When an agent is working on a section, the heading shows "Claude is working on this section". You can keep editing;
other agents wait until it is done.

### How agents edit

Workspace owners and admins choose in Workspace settings → **Connected agents** → **How agents edit**:

- **Edit directly** (default): agents write like their person. Every change is in the page history.
- **Accept by rules**: agent edits become suggestions, and the ones that match your rules are accepted at once. By
  default that is additions to the end of a section, new sections and lines under a heading, from any connection.
  You can also allow replacing or removing sections, limit the rules to some connections, cap the size, and add a
  wait so people can reject first. Whatever the rules say, an edit is only accepted while its section is exactly as
  the agent read it; if someone changed it, a person decides. Changes to a whole page always wait for a person.
- **Review everything**: every agent edit waits for a person.

Edits accepted by a rule show "Accepted by rule" in the suggestions history and "… · auto-accepted" in page history
and activity. A locked page or folder can choose its own way in the [lock dialog](#edit-lock). This setting covers
page text; renaming, moving and deleting pages follow the lock as before.

### Reverting agent edits

In **Activity** or in the page's side panel (**History › Recent changes**), changes made through an agent have
**Revert**. Choose only that change, everything that agent changed on this page, or (owners and admins) in the whole
workspace, and a period. The preview shows what will be reverted and what stays because someone edited it afterwards.
Reverting is saved as your own change (a "Before revert" version is kept) and can be undone with **Undo revert**.

### Team agents

**Team agents** in the header of **Activity** shows what each person's AI connections are working on: the sections they claimed
with the minutes left, their suggestions waiting for a person, and what each one did today. Pages you can't open
are listed without their title.

You can hand work to one person's agent instead of the person:

- In a comment or a to-do, type `@` and pick an entry like "Bob · Claude Code". Only that agent's inbox gets it;
  Bob's other agents don't, and Bob's bell doesn't either.
- In a database, open a person cell and pick one of the person's agents under their name (**Or one of their
  agents**). The cell keeps the person; the agent shows next to it.
- To see what is handed to your own agents, turn on Settings → **Notifications** → **Show me what is handed to my
  agents**.

If an agent connection is disconnected or expires, what was handed to it goes back to its person. Being handed work
gives an agent no extra rights: it still acts as its person.

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

Settings → **Sidebar** chooses which of Search, Later, Threads, Graph, Tags, Web shares, Due, Calendar, Activity and Today appear
at the top of the sidebar, and in what order (drag, or the ↑/↓ buttons, which appear when you hover
over a row or reach it with the keyboard). Until you change it, the sidebar shows Search, Later, Due and Calendar;
**Reset to default** goes back to those four. You
can also right-click (or long-press) a menu → **Hide from sidebar**. Hidden menus still open from the ⌘P palette
and their shortcuts.

The page list always keeps a good part of the sidebar's height. When the menus don't fit above it (a laptop
with every menu on, a tablet with the browser's bars), the last ones fold under **More**; tap it to see them
all, and again (**Show less**) to fold them. On a short screen the trash, shortcuts, settings and account rows
become one row of icons at the bottom.

⌘\ hides or shows the whole sidebar. To make it wider or narrower, drag its right edge (200–480 px);
double-click the edge to go back to 260 px. With the edge focused, ←/→ change the width (Shift for bigger steps).
The width is kept on this device only.

## Keyboard shortcuts

Press `?` (outside a text field) to see this list in the app, grouped by where each key works; type in its search box
to keep only the matching rows (English or Korean names, Korean initial consonants such as ㄱㄹㅍ, or a key such as
⌘⌥). Settings → Keyboard shortcuts shows the same list and lets you change the keys (below).

**Changing keys.** In Settings → Keyboard shortcuts, click a command's key and press the new combination; Esc
stops without changing anything, **No key** leaves the command without one. A key needs ⌘, ⌥ or ⌃ (Ctrl or Alt on
Windows and Linux), except F1–F12, and arrows, Enter, Tab or Space for the sidebar tree and the database table.
Keys the system or the browser never hands to a page (⌘W, ⌘Q, ⌘Tab, developer tools) and ⌘A/⌘C/⌘X/⌘V are refused.
If another command already has the key, Inkling names it and asks before moving the key over. Keys a browser tab
keeps for itself (⌘N, ⌘⇧N) or browser functions (⌘F find, ⌘R reload, zoom) can be used after a warning. Commands
without a default key, such as *Today's daily note*, *Later*, *Threads* or *Save this page for later*, can get one too. Keys built into the editor (bold, italic,
headings, lists, moving blocks, undo) and the table's copy and paste are marked **Built in** and stay as they are.
A new key works at once, in open pages and in the editor too, and the `?` window, the palette and the menus show it.
**Default** puts one command back, **Reset all** every command. Your keys are saved in this browser only; **Export**
saves them as a JSON file and **Import** loads such a file on another device (a file that would put two commands on
one key is refused).

**Command palette.** ⌘P lists every command that can run on the current screen, each with its key, and finds pages
by title once you type. It searches the English and the Korean name of each command, so "sidebar", "사이드바" and
"ㅅㅇㄷ" all find *Toggle sidebar*. With an empty box the commands you ran last come first. ↑/↓ move, Enter runs,
Esc closes. Editor commands (headings, move block, duplicate…) act on the block where the cursor was. Menu items
that have a key show it at the right (page ⋯ menu, the tree's row menu, the sidebar).

| Action | Mac | Windows / Linux |
|---|---|---|
| **Global** | | |
| Search | ⌘K | Ctrl+K |
| Quick switcher (titles) | ⌘O | Ctrl+O |
| Full-text search | ⌘⇧F | Ctrl+Shift+F |
| Command palette | ⌘P | Ctrl+P |
| New page | ⌘⌥N or ⌘N | Ctrl+Alt+N |
| Back | ⌘⌥← | Alt+← |
| Forward | ⌘⌥→ | Alt+→ |
| Graph | ⌘G | Ctrl+G |
| Settings | ⌘, | Ctrl+, |
| Toggle sidebar | ⌘\ | Ctrl+\ |
| Shortcut help | ? | ? |
| **Page** | | |
| Rename title (outside the tree) | F2 | F2 |
| Open properties panel | ⌘; | Ctrl+; |
| Toggle right panel | ⌘⌥\ | Ctrl+Alt+\ |
| Add to / remove from favorites | ⌘⌥S | Ctrl+Alt+S |
| Pen mode on / off | ⌘⌥P | Ctrl+Alt+P |
| **Editor** | | |
| Block menu | / | / |
| Bold | ⌘B | Ctrl+B |
| Italic | ⌘I | Ctrl+I |
| Underline | ⌘U | Ctrl+U |
| Strikethrough | ⌘⇧S | Ctrl+Shift+S |
| Inline code | ⌘E | Ctrl+E |
| Inline math (wraps the selection) | ⌘⇧E or `$…$` | Ctrl+Shift+E or `$…$` |
| Turn into text | ⌘⌥0 | Ctrl+Alt+0 |
| Turn into heading 1 | ⌘⌥1 | Ctrl+Alt+1 |
| Turn into heading 2 | ⌘⌥2 | Ctrl+Alt+2 |
| Turn into heading 3 | ⌘⌥3 | Ctrl+Alt+3 |
| Turn into toggle list | ⌘⇧6 | Ctrl+Shift+6 |
| Turn into numbered list | ⌘⇧7 | Ctrl+Shift+7 |
| Turn into bulleted list | ⌘⇧8 | Ctrl+Shift+8 |
| Turn into to-do list | ⌘⇧9 | Ctrl+Shift+9 |
| Toggle checkbox | ⌘L | Ctrl+L |
| Check / uncheck the to-do | ⌘Enter | Ctrl+Enter |
| Move block up | ⌘⇧↑ | Ctrl+Shift+↑ |
| Move block down | ⌘⇧↓ | Ctrl+Shift+↓ |
| Indent block | Tab | Tab |
| Outdent block | ⇧Tab | Shift+Tab |
| Duplicate block | ⌘⇧D | Ctrl+Shift+D |
| Delete current block | ⌘D | Ctrl+D |
| Fold / unfold the section at the cursor | ⌘. | Ctrl+. |
| Undo | ⌘Z | Ctrl+Z |
| Redo | ⌘⇧Z | Ctrl+Y or Ctrl+Shift+Z |
| **Sidebar tree** | | |
| Select the row above | ↑ | ↑ |
| Select the row below | ↓ | ↓ |
| Collapse, or go to the parent | ← | ← |
| Expand, or go to the first child | → | → |
| Open / toggle folder | Enter | Enter |
| Rename | F2 | F2 |
| Move to trash | ⌘⌫ | Ctrl+Del or Del |
| **Database table** | | |
| Move to the cell above | ↑ | ↑ |
| Move to the cell below | ↓ | ↓ |
| Move to the cell on the left | ← | ← |
| Move to the cell on the right | → | → |
| Next cell | Tab | Tab |
| Previous cell | ⇧Tab | Shift+Tab |
| First cell of the row | Home | Home |
| Last cell of the row | End | End |
| Extend the selection up | ⇧↑ | Shift+↑ |
| Extend the selection down | ⇧↓ | Shift+↓ |
| Extend the selection left | ⇧← | Shift+← |
| Extend the selection right | ⇧→ | Shift+→ |
| Edit the cell (Enter saves and moves down, Esc cancels) | Enter or F2 | Enter or F2 |
| Check / uncheck a checkbox cell | Space | Space |
| Clear the selected cells | ⌫ | Del |
| New row | ⌘Enter | Ctrl+Enter |
| Open the row as a page | ⌘⇧Enter | Ctrl+Shift+Enter |
| Copy the selected cells | ⌘C | Ctrl+C |
| Paste cells | ⌘V | Ctrl+V |
| **Pen mode** | | |
| Undo the last stroke | ⌘Z | Ctrl+Z |


Editor keys work while the cursor is in a document. ⌘D deletes the block (as in Obsidian); ⌘⇧D duplicates it
(Notion's ⌘D). ⌘Enter checks or unchecks a to-do and does nothing on other blocks; ⌘L also turns text into a to-do.
In a normal browser tab ⌘N opens a new browser window, so use ⌘⌥N; the installed app takes both. In Chrome on a Mac
⌘⌥←/→ switch browser tabs, so in a tab use the browser's own ⌘[ / ⌘] for back and forward; the installed app takes
⌘⌥←/→. While a Korean (or other) input method is composing a character, shortcuts wait until the character is
done. On Windows, Ctrl+Alt combinations that your keyboard layout uses to type a character (AltGr) type that
character.

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
