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
- [Save from the web](#save-from-the-web)
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
- **Servers set up differently.** The person who runs a server (a demo server, for example) can change how you sign
  up. You may sign up with an **ID** and a **Nickname** instead of an email address (3 to 30 lower-case letters,
  digits, `.`, `_` or `-`); keep your real name, email address and phone number out of both. You may have to tick the
  server's notices and terms before **Sign up**; `/terms` and `/privacy` open without signing in, and Settings links
  to them. A label such as "Demo" can be shown on every screen.
- **When the terms change**, you see **Agree to the terms to continue** after signing in, before anything else: read
  them and **Agree and continue**, or **Sign out without agreeing**. The same screen has **Delete my account**.
- **A deletion date.** On a server that deletes accounts some days after sign-up, "This account will be deleted on
  YYYY-MM-DD." is shown under the workspace switcher (above the page on a phone, and on every screen in the last
  three days), with an **Export** link. Export what you want to keep before that date.

### The intro and the Getting started card

A new account sees a short intro the first time it opens Inkling: writing together, an AI agent reading
just the sections it needs, an agent's edit that a person accepts, and your own server with offline copies.
Skip it with **Esc** or the Skip button; ← and → change scenes and Space pauses. At the end it stops on a
screen with next steps: open (or make) the sample page, **New page**, **Connect an AI agent** and **Close**.
With "reduce motion" turned on in your system, the intro shows one still picture per scene and the same
end screen after the last one.

The **Getting started** card on the empty workspace screen (and folded at the bottom of the sidebar)
lists a few first steps. They tick themselves as you do them, on every device. Press an item to go
where it is done; a short bubble points at the button. **Make a sample page to try things on** creates a page in
your private pages (only you see it); delete it when you are done, it does not come back.
**Don't show again** hides the card. Opened in the sidebar, the card takes only the room the menus and the
page tree leave and scrolls inside when its list is longer; when even that room is too small (a short window
with **More** open), it stays folded until there is room.

Settings → About → Getting started: **Watch the intro again**, and a switch to show the checklist again.
Accounts that existed before the upgrade start with the checklist off, and see the intro only if the
server's operator set `ONBOARDING_EXISTING_USERS=once`. The intro never opens while you are typing.

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

**Usage.** Workspace settings → General shows the workspace's members, pages (the trash included) and storage (files,
page bodies, version history, handwriting, comments and the trash). On a server with limits it shows "used of limit".
Creating past a limit (pages, members, the workspaces you own, the size of one file) shows a message that names it;
deleted workspaces count toward the ones you own until they are deleted for good. When the storage is full, the
workspace is read-only for everyone and a notice above the page says so. Delete files or pages and empty the trash,
then open the usage again: once the server counts the workspace under its limit, open pages can be edited again.

**Groups and archive.** Open the workspace menu at the top of the sidebar and choose **Organize workspaces…**. Make
groups such as "Contests" or "Classes", choose a group for each workspace, and drag (or use the arrows) to change the
order. Archive a workspace you are done with: it moves to **Archived** at the bottom of the menu, still one click
away, and your searches across all workspaces (and your AI agents' default searches) skip it. This is only your list;
other members see no change, and an archived workspace stays open and editable. **Unarchive** brings it back. The same
editor is in Settings → Sidebar.

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
- **Database view**: one view of a database inside this page (see [Databases](#databases)).

**Tables**: type a row such as `| Name | Role | Due |` on an empty line and press Enter: it becomes a table with
that header row and an empty row to fill in (⌘Z right after turns it back into text). `/table 3x4` inserts an
empty table of 3 columns × 4 rows (`/표 3x4` and `3*4` work too). A Markdown table pasted as text becomes a table.

You can also drop images and files onto the page. The title is the large text at the top; F2 jumps to it.

### Columns

Type `/2단` or `/3단` (in English "2 columns", "3 columns") on an empty line to split it into columns side by side;
the caret goes into the first one. Write in each column as anywhere else: any block works, including images,
to-dos, code, callouts and toggles. Arrow keys move between columns; Tab and Shift+Tab indent inside a column.
Backspace at the start of a column moves the caret to the column on its left instead of pulling the line out.

To change widths, point between two columns and drag the line that appears; a double-click on it makes all
columns equally wide. The block menu (⋮⋮ beside a block) of anything in a column has **Add column** (up to four),
**Delete this column** (what was in it moves to the end of the column on its left) and **Unwrap columns** (the
group becomes ordinary blocks again, column after column). Columns cannot go inside columns.

On a narrow screen the columns stack, first column on top. A heading inside a column does not start a section:
it is not in the outline, does not split presentation slides, and agents patch the section around the group.
Images inside columns open large like any other (see *Looking at images*).

### Math

- Display equation: `/` → **Math block**.
- Inline equation: type `$x^2$`, press ⌘⇧E (wraps the selection), or `/` → **Inline math**.
- Click an equation to edit its LaTeX with a live preview. Prices like `$5 and $10` stay text.

### Diagrams

A code block in language **mermaid** (or `mmd`) draws a [Mermaid](https://mermaid.js.org) diagram under its code:
flowcharts, sequence diagrams, Gantt charts and the other Mermaid types. The code shows while you edit it; click the
diagram to edit, or **Show code** to keep the code open. A mistake in the code shows **Diagram error** with one line
saying what is wrong. Diagrams follow the light and dark theme, show alone in presentation mode, print in **Export as
PDF**, and are drawn on public pages too. Agents, exports and vault sync see the ```mermaid code.

### Buttons

Type `/button`. Give it a label and a color, then add up to five actions: **Add a row** to a database (pick a template
and fill values; `today`, `today+7`, `me`, `this page` and `{{today}}`, `{{me}}`, `{{page}}` in text), **Set values
of this row** (when the page is a database row), **Open** a page or a link, **Send to a webhook** (one a workspace
owner registered). Pressing the button runs the actions in order with your own access: if you cannot add rows to that
database, the button cannot either. If an action fails, the button says which one and stops. On public links and in
presentation mode the button is shown but cannot be pressed.

### Links, mentions and tags

- `[[` links to another page. Pick from the list or choose **＋ New page: "…"** to create it.
- `[[Page#` links to a heading of that page: pick one of its headings. The link opens the page at that heading and
  keeps working when the heading is renamed or moved; if the heading is gone, the page opens and says so. The
  backlinks panel shows which heading each linking page points to.
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

### Looking at images

Double-click a picture in a page, or point at it and press the magnifier in its top right corner, to see it
large. On a phone or tablet the magnifier is always there. On a page you can only read (locked for you) and on a
public link, one click on the picture opens it; a picture that is itself a link on a public page follows the link.
A single click in a page you can edit still selects the image block, so its toolbar, resize handles and drag work
as before.

In the viewer, zoom with the mouse wheel, a trackpad pinch or two fingers on a touch screen; the point under the
pointer stays put. `+` and `-` zoom in steps, `0` fits the picture to the screen, and a double-click switches
between fitted and actual size (100%); a picture smaller than the screen is shown at 100% and is not enlarged to
fit. When it is larger than the screen, drag to move around. If the page has several pictures, ← and → (or the
arrows at the sides) go to the previous and next one; the top bar shows which one ("2 / 5"), its caption or file
name, the zoom and **Open original**, which opens the picture in a new tab. Esc, a click outside the picture or the
close button closes it and puts you back where you were. The browser's Back button goes back as usual and closes
the viewer on the way. While it is open, keys go to the viewer only, never to the page behind it. The `?` window lists these keys under **Image viewer**.

### Reading PDFs in the page

A PDF you attach shows its pages right under the file name. Scroll inside the preview to turn pages, type a page
number to jump, use − / + to zoom or **Fit width** to fit the page to the column, and **Full screen** to read it
over the whole window. Esc or the close button closes it and the preview below the file name moves to the page you
were reading; the browser's Back button goes back as usual and closes it on the way. You can select text in the
PDF and copy it; web links in the PDF open in a new tab, and a link to another page of the same PDF scrolls there.
PDFs up to 10 MB open as soon as you scroll to them. A larger file shows **Load preview** with its size, so you
decide when to spend the data (with the browser's data saver on, every PDF waits for that press). **Hide preview**
folds it to one line, and this browser remembers that for you. The preview is only on your screen: scrolling or
zooming changes nothing in the page for others, and each person reads at their own page. Password-protected or
damaged PDFs cannot be previewed, nor PDFs of more than 5,000 pages; download them instead. Public links show the
file name only, as before.

On a page with handwriting and in pen mode, PDFs show only their file name, so the ink stays where you wrote it
(ink is placed by the page's height, and you cannot write on a PDF). When someone else writes the first stroke on
a page you have open, its previews go away within a minute.

### Verifying a page

Mark a page as checked and correct until a date: **⋯** → **Verify page…** → choose 30, 90 or 180 days or **Until a
date…** (at most a year), add a note if you like, then **Mark verified**. A badge under the title says "Verified
until …". After the date it turns into **Needs verification**. The badge also shows how many sections changed since
it was verified. People who can edit the page can verify it; when the page has an owner, only the owner or a
workspace owner or admin. **All verified pages** lists the pages that need verification, the ones that expire within
7 days and the verified ones. Connected AI agents see the mark too, and are told when a page is out of date.

### Presenting a page

**⋯** → **Present** (also on a shared page) shows a document as full-screen slides. Slides start at the page's
headings: at the shallowest heading level you use more than once, and at any heading above it (one H1 at the top
with H2 sections gives a slide for the H1 and one per H2). A divider also starts a new slide. Move with ← / → (or
PageUp / PageDown, Space, Home / End) or swipe; Esc leaves. A slide longer than the screen scrolls: use the mouse
wheel, swipe up or down, or ↑ ↓. The slides are a copy of the page when you opened them: edits made meanwhile show
after you open it again. Buttons on the slides cannot be pressed.

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

- **Views:** Table, Board, Calendar, Gallery, Timeline, Chart, Form, List. Add one with **New view** in the view tabs.
- **Properties:** Text, Number, Select, Multi-select, Date, Checkbox, Person, URL, Email, Phone, Relation, Rollup,
  Formula, and the automatic ones: Created time, Last edited time, Created by, Last edited by and **ID**. Add one with
  **Add a property**. Automatic properties fill themselves in and cannot be edited; "Last edited by" says "(via
  Claude)" when an agent made the change. **ID** numbers the rows (`TASK-12` with the prefix `TASK`); a number is never
  given twice, and existing rows are numbered when you add the property.
- **Sort & filter** sets sorting, filters and visible properties per view. Boards group by a select property.
  **Match: All / Any** decides whether every condition or one of them must hold, **Not** turns a condition around,
  and **Add group** makes a group of conditions with its own All / Any.
- **Sub-items:** **⋯ → Turn on sub-items** adds a **Parent item** property. Add a sub-item from a row's menu
  (**Add sub-item**) or by picking the parent. Table and list views show the rows as a tree you can fold; **Nested /
  Flat** in the view settings switches it. A row cannot be put under itself or its own sub-items.
- **Show a database in a page:** type `/database view` and pick the database and the view. The block shows that view
  with the rows each reader may see and updates with the database. Click a row to open it, or **Open database** for
  the full view; switch the view from the block's header. The block is read-only. A database someone cannot see shows
  "Database not available" to them.
- **Agent task board:** the template of the same name makes a database for AI agents that split work: tasks with
  sub-tasks, an assignee (a person or their agent), evidence and `TASK-n` IDs ([RECIPES.md](RECIPES.md)).
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

### Automations

Open a database's **⋯** menu → **Automations** → **New automation**. Choose when it runs (a row is added, a property changes,
optionally to one value, or a date is N days away), optionally a condition, and what it does: set values, assign a
person, notify people, send to a registered webhook, add a row to another database, or hand the row to a person's
AI connection (up to five actions, 20 rules per database). A rule runs as the person who last saved or turned it on,
right after the change; what it changes shows as "<name> via automation: <rule>". The run log shows each run; five
failures in a row turn a rule off and notify its author. Rules started by guests, public form answers or AI
connections cannot write to other databases. Connected AI agents see a database's rules but cannot make them.

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
online and the connection state. Changes made while the connection is down merge when you reconnect. With offline
copies on (see *Working offline*), they are kept on the device; without them, only as long as the tab stays open.

While some of your edits have not reached the server, the connection dot turns amber. It reads **Not uploaded yet**
when the edits are stored on this device, and **Not saved yet** when they exist only in this tab (hover it for
"Some edits have not reached the server yet. Keep this tab open until they are saved."); only then does closing or
reloading the tab ask you first. Opening another page inside the app is fine: the edits of the page you left are
kept until the server has them.

A tab that still runs an older version of the app (opened before your server was updated) can read pages that
use something it does not know, such as columns in 0.20, but not edit them; reload it. In 0.20 and later such a
page says "This page has content that only a newer version of the app can edit. Reload to update."; a 0.19 tab
shows the page as locked instead.

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

**Push notifications.** Settings → Notifications → **Push notifications** → This device → **Turn on**. Your browser
asks once for permission; notifications then reach this device with the app closed. Choose what to push, pause it
for all devices, or hide the content on the lock screen ("New notification" only). **Send a test** checks a device.
On iPhone and iPad, add Inkling to the Home Screen first and open it from there (iOS 16.4 or later; not yet
checked on a real iPhone or iPad). Signing out of a
device stops its pushes. A database automation that notifies you arrives as a mention: "Alice via automation: Ping
reviewer mentioned you in …". Push needs the server on HTTPS; if Settings says push is not available here, ask your
server admin.

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
  they get a **Guest** badge. A database shared with a guest opens for them: they see its rows (links to pages they
  cannot see stay hidden), and with **Can edit** they add rows and edit cells, but they cannot assign people or
  change properties and views.
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

A public page also shows its embedded pages, database views and query results, but only from pages that are part of
the link (anything else is one line, "Embedded content that is not part of this link"), and draws Mermaid diagrams.

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

### Reading, printing and downloading

Visitors of a public link see a row of actions above the title (one **⋯** button on a phone):

- **Present** shows the page as slides.
- **Wide view** uses the whole window for tables, code and diagrams; text keeps a readable width. A page
  with "Full width" turned on opens wide. Your choice is remembered in your browser.
- **Save as PDF** opens your browser's print dialog; pick "Save as PDF" there. The PDF has the page only,
  on white, named after the page.
- **Download Markdown** appears when the person who shared the link allowed it. Turn it on in the share
  dialog under the link's settings: **Let visitors download it as Markdown**. The file holds only what the
  public page shows. It is off for every new link, and publishing again turns it off.

Charts are not on a public link unless you choose so: a chart shows numbers from a database that the link itself
usually does not share. The share dialog tells you how many charts of the page (a folder link: of its pages) do not
show. Turn on **Show charts on the public page** in the link's settings to publish them. Visitors then see each chart
— its title, the names of its bars or slices and their values — but not the rows behind it, the database's name, or
anything else from the workspace. The numbers are worked out with the access of the person who turned the setting on:
if that person leaves the workspace, or can no longer see a chart's database, that chart disappears from the public
page. Turning the setting on approves the databases (and queries) the charts use at that moment: if someone later adds a
chart over another database, it stays off the public page and the share dialog says "1 newly added chart is not
public yet" until an owner or admin presses **Publish these charts too** (from then on, with that person's access).
New charts over an approved database show at once. Numbers can be up to 10 minutes behind the database. A folder link
always shows the charts of databases that are inside the folder. New links start with charts off, and so does a link
published again after it was stopped.

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
them (always, for matching pages, or only when asked by name). If an instruction page gets long (over 200 lines or
25 KB), the dialog says so and the page's lock line shows **long**. Agents read it in full every session; keep it to
rules and links to where things are.

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
`https://notes.example.com/mcp`. **Manage connections** opens **Connect an AI app**: pick your app (Claude Code,
claude.ai / Claude Desktop, Cursor, VS Code or another app) and copy what it shows (a command, a JSON file or the
URL). Under **Tools**, **Core tools** gives the agent the tools it uses most (a shorter tool list costs fewer tokens
in every session; the rest stay one call away) and **All tools** gives it everything, for an agent that builds
databases, charts or templates. Core tools add `?profile=core` to the URL.

**Claude Code**

```bash
claude mcp add --transport http inkling https://notes.example.com/mcp
```

Then run `/mcp` in Claude Code, choose `inkling` and authenticate. Your browser opens Inkling's consent screen.
Sign in if asked, pick the access level and click **Allow**.

If Claude Code runs on another machine over SSH, the "return to the app" button can't reach it. Use
**Copy command** on the consent screen and run that command in a terminal on that machine, within 5 minutes.

**claude.ai**

Customize → Connectors → **+ Add** → **Add custom connector** → URL `https://notes.example.com/mcp` → Connect. Sign in
in the window that opens and click **Allow**. Leave the OAuth client ID and secret empty. The server must be reachable
from the internet: claude.ai connects from Anthropic's servers.

**Apps that cannot sign in**

If your app cannot sign in here (it does not support sign-in for MCP servers, or your server is on a plain `http://`
address or uses a certificate the app does not trust), make an **agent connection token** on the same screen
(**Agent connection tokens** → **New token**): a name, which is shown as "via …" next to its edits, read only or read
and write, what it may see, and an expiry (7, 30, 90 or 365 days; there is no "never"). Then pick **Agent connection
token** under **Sign-in** in **Connect an AI app**: the command or file it shows has the token filled in while it is on
screen. Copy it then; it is not shown again. The token works only for the AI connection, and it counts as an agent
like a signed-in app: agent locks, workspace rules for agents and review of agent edits all apply. **Revoke** stops it
at once.

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
- open attachments: images, text files and the text of PDFs (not scanned ones), and the name and size of other files,
- attach a file it made (an image, a PDF or a text file, up to 5 MB by default) to a page it may edit, where the
  workspace allows it,
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
- AI agents receive page text marked as data, not as instructions. The mark helps an agent tell your notes from
  its instructions, but on its own it cannot stop a cleverly written page from misleading the agent. What limits an
  agent is what you allow it: a read-only connection, a narrower range, edit locks that keep agents to suggestions,
  comments or reading, and version history to undo its edits. Pages with suspicious text show
  **Possible prompt-injection text**. The warning may be a false positive, and some suspicious text is not caught.
- An agent that reads such text (in a page or an attachment) only suggests for an hour: its edits wait for review and
  its other changes are refused. Its connection shows **Suggestions only until HH:MM**; **Allow edits again** lifts it.
  Workspace owners and admins can turn this off in Workspace settings → **Connected agents** → **Suspicious content**.
- Workspace settings → **Connected agents** → **File uploads** sets whether AI agents may attach files in the
  workspace (server default, on, off). People's uploads are not affected.

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

An agent that read suspicious text shows **Suggestions only until HH:MM** here. Workspace owners and admins (and the
agent's person) can click **Allow edits here** when that text was in this workspace.

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

## Save from the web

On a computer: Settings → Connections → **Web clipper**, drag **Save to Inkling** to the bookmarks bar. On a page,
select text if you like and click it: a small window opens with the title, address and selection. Pick the workspace
and where to save (the last place is remembered, and you can set a default), add tags, choose **Link and note** or
**Article text** (the server fetches the page and keeps its main text), then **Save**. If you clipped the same address
before, the window says so. Some sites block bookmarklets; then paste the address into `/clip` in the app.

On an Android phone: install Inkling as an app, then share a link from any app to Inkling (not yet checked on a
real Android phone).

## Importing from Notion

1. In Notion: Settings → Export (or ⋯ → Export on a page) → **Markdown & CSV**, with subpages included and
   folders created for subpages.
2. In Inkling: workspace menu → **Import from Notion (.zip)** → **Choose .zip**, and upload the file as it is.

Pages become documents, CSV databases become databases, images and files are uploaded, and equations become math.
Callouts arrive as quotes. A report shows what was imported and which links weren't found.

The same menu also has **Import (.md/.zip)** for Markdown files and **Import folder** for a folder of `.md` files.

## Export

- One page: **⋯** menu → **Export (.md)**, or **Export with subpages (.zip)**. Canvases export as `.canvas`.
  Charts, database views and query blocks are written with a table of their numbers at export time; importing the
  file brings the blocks back.
- PDF: **Export as PDF** in the page header's **⋯** menu opens the browser's print dialog. Wide tables are fitted to
  the page width (smaller type from 7 columns; for very wide tables choose landscape there), closed toggles print
  their contents, and the dark theme prints in light colors.
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
- The trash keeps pages for 30 days unless an owner changed it (Workspace settings → General → **Keep trash for**). A
  server can set a shorter ceiling; the setting then says so and takes nothing above it.
- Settings → Files & links → **Confirm before deleting**: when off, pages go straight to the trash with an "Undo" toast.
- **History** in the right panel lists saved versions. **View all** opens **Version history**: preview a version,
  **Compare with current**, **Snapshot now** to save one yourself, or **Restore this version** (the current state
  is saved first).
- Every change an AI agent writes is its own version, **AI edit · step n**, with what it changed (which sections,
  how many lines). Restore the step before a bad one to undo just that part; later steps stay in the list.
- A deleted workspace can be restored by its owner from Settings → Account → **Deleted workspaces** for 30 days (a
  server can set another number; the screens show it). **Delete now** next to it deletes it for good at once, with
  its pages and files; it cannot be restored after that.

## Settings and the sidebar

Open Settings with ⌘, or **Settings** at the bottom of the sidebar. The sections (Account, Security, Notifications,
Editor, Sidebar, Files & links, Appearance, Connections, Keyboard shortcuts, Offline, About) are listed on the left and the
chosen one opens on the right; on a phone the list comes first and a section opens over it. Two-step verification is
under Security; the app version, a link to this guide, the intro and the Getting started checklist are under About.

Saved to your account (the same on every device):

- **Account**: email verification, **Change password**, deleted workspaces, **Delete account**.

**Delete account** (Settings → Account) first lists what goes: the workspaces where you are the only member and the
deleted workspaces you own alone, with their pages and files, your private pages in other workspaces, your account, sign-ins, tokens and connected apps. It also lists
what stays for the other members: a shared workspace you own alone passes to another member, and your shared pages
and comments stay without your name. Type the confirmation it shows (your email or ID) and your password, plus the
two-step code when that is on; an account that signs in through another service must have signed in within the last
ten minutes. It cannot be undone, and nothing is kept for restoring. The only admin of a server cannot delete their
account.
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
with every menu on, a tablet with the browser's bars), the last ones fold under **More (n)**; tap it to see all
n of them (the page list gets shorter while it is open), and again (**Show less**) to fold them. On a very short
window the open list scrolls, with a "k more below" row at the bottom. On a short screen the trash, shortcuts, settings and account rows
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
| **Image viewer** (while it is open) | | |
| Zoom in / zoom out | + / - | + / - |
| Fit to screen (double-click: 100%) | 0 | 0 |
| Previous / next image | ← / → | ← / → |
| Close (or click outside the image) | Esc | Esc |


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

### Working offline

Turn on Settings → Offline → **Keep offline copies on this device** (it is on by default in the installed app, off in
a browser tab). Every page you open is then kept on the device: without a connection the app still starts, shows the
page list from your last visit, and opens those pages for reading and editing. A banner says when you are offline;
the dot next to the page says **Not uploaded yet** while your edits wait on the device. When the connection is back
they are uploaded and you see **Offline edits uploaded**. If someone restored an older version of the page, reverted
or split it, moved it to the trash or took away your edit right in the meantime, your offline edits are not mixed
into it: they are kept under Settings → Offline → **Recovery**, where you can read them and copy what you need.
Offline you cannot create, move or delete pages, open databases, attachments or the canvas, or search. If the
browser's storage does not answer, the page opens from the server after about 5 seconds instead of waiting on
"Connecting…"; that tab then keeps no device copies until you reload it. Logging out deletes everything the device kept. The copies are not encrypted, so leave the setting off on a shared computer.

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

**The screen says "This screen could not be shown".**
Something failed while drawing it. Press **Reload**; if a page keeps failing, the sidebar still works, so you can
open another page. When you report it, copy the text under **Details**. If the app does not start at all, a notice
with a reload link appears after 12 seconds.

**How do I leave a workspace?**
Workspace settings → **Danger zone** → **Leave workspace**. Your private pages there go to the trash. If you are
the only owner and there are other members, transfer ownership first. If you are the only member, leaving deletes the
workspace with its pages and files and cannot be undone: type its name and press **Leave and delete**, or choose
**Delete, restorable for N days** instead.
