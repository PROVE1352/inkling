# Press the buttons and watch an agent edit a note

> This is a demonstration that runs in your browser only. It is not connected to a real server or an AI, and nothing you type is saved.

In Inkling an AI agent finds only the sections it needs, checks the version it read, and changes one section. Run the five scenes below in order. No account and no server needed.

Tool names, arguments and the shape of each answer are those of the real Inkling MCP server. The note, the version values (v=…) and the token counts are examples made up by this tour, and page and suggestion ids are shortened.

## The note used in the tour

One page of a made-up workspace. It has four sections, and in every scene the agent works on the Checklist section.

```markdown
# Q4 launch plan

## Goals

- Launch the new plans on November 20
- Send the launch email the day before

## Schedule

- Nov 13: pricing page copy final
- Nov 18: status page check
- Nov 19: launch email goes out

## Checklist

- [x] Pricing page copy
- [ ] Status page, owner Sam Ortiz, due 2026-11-20
- [ ] Support macros for the new plans

## Owners

- Launch lead: Priya Nair
- Status page: Sam Ortiz
```

## 1. Find

The agent calls `find_context` once and the server answers with the sections that match the question, ranked and packed into a token budget (3,500 by default). Each result carries the page id, a §anchor and a version (v=…), which the editing tools take as they are.

```text
› find_context(query: "launch checklist status page")
1 result(s) for "launch checklist status page", ~37/3500 tokens
<untrusted_content source="find_context">
[1] Q4 launch plan › Checklist
(page 3e8a2ebe; §checklist v=11d46ddf8928; can: read,comment,edit; edited by Priya Nair)
- [x] Pricing page copy
- [ ] Status page, owner Sam Ortiz, due 2026-11-20
- [ ] Support macros for the new plans
</untrusted_content>

Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.

# reading the whole page would have been about 101 tokens; this answer is about 37 tokens (estimates for the tour)
```

In the product the search covers all your workspaces. In the measurement in the performance log the average per question went from 2,254 to 624 tokens. The comparison in this scene is an estimate for the tour note.

- [MCP guide: Guide for agents](../docs/MCP.md)
- [Performance log: Retrieval & MCP](../docs/PERFORMANCE.md)

## 2. Change one section

`patch_section` changes one section. The agent sends the version it read as `baseVersion`, and the server writes only if the section is still at that version. The other sections are not touched; only the edited section gets a new version.

```text
› find_context(query: "launch checklist status page")
1 result(s) for "launch checklist status page", ~37/3500 tokens
<untrusted_content source="find_context">
[1] Q4 launch plan › Checklist
(page 3e8a2ebe; §checklist v=11d46ddf8928; can: read,comment,edit; edited by Priya Nair)
- [x] Pricing page copy
- [ ] Status page, owner Sam Ortiz, due 2026-11-20
- [ ] Support macros for the new plans
</untrusted_content>

Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.

› patch_section(pageId: "3e8a2ebe", section: "checklist", mode: "append",
    markdown: "- [ ] Changelog post", baseVersion: "11d46ddf8928")
Done (append): §checklist is now v=9714a6acf399.
```

In the product every write of an agent is one "AI edit" version in the page history, and a person can undo that step alone.

- [MCP guide: Versions, one per agent write](../docs/MCP.md)
- [User guide: Reverting agent edits](../docs/GUIDE.md)

## 3. Conflict

If a person edits a section after the agent read it, the edit sent with the old version is refused and nothing is written. The answer contains the current text and its version, so the agent merges its change and sends it again. Press run, then edit the Checklist section yourself.

```text
› find_context(query: "launch checklist status page")
1 result(s) for "launch checklist status page", ~37/3500 tokens
<untrusted_content source="find_context">
[1] Q4 launch plan › Checklist
(page 3e8a2ebe; §checklist v=11d46ddf8928; can: read,comment,edit; edited by Priya Nair)
- [x] Pricing page copy
- [ ] Status page, owner Sam Ortiz, due 2026-11-20
- [ ] Support macros for the new plans
</untrusted_content>

Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.

# (person) edits the Checklist section after the agent read it: ticks the status page item

› patch_section(pageId: "3e8a2ebe", section: "checklist", mode: "append",
    markdown: "- [ ] Draft the customer email", baseVersion: "11d46ddf8928")
Conflict: Section "checklist" changed since baseVersion 11d46ddf8928; nothing was written. Merge your edit into the current content and retry with baseVersion feb43b079c48.

Current §checklist (v=feb43b079c48):
## Checklist

- [x] Pricing page copy
- [x] Status page, owner Sam Ortiz, due 2026-11-20
- [ ] Support macros for the new plans

# (agent) merges its line into the current text from the answer and sends it again with the new version

› patch_section(pageId: "3e8a2ebe", section: "checklist", mode: "append",
    markdown: "- [ ] Draft the customer email", baseVersion: "feb43b079c48")
Done (append): §checklist is now v=9f98b3843996.
```

That is how a person's typing is not overwritten by an agent's edit.

- [MCP guide: Guide for agents](../docs/MCP.md)

## 4. Leave a suggestion

When a page is locked to "agents: suggestions only", an agent's edit is not written; it waits as a suggestion. A person looks at the changed lines and accepts or rejects it. There is no tool for an agent to accept a suggestion.

```text
# (person) locks this page to "agents: suggestions only"

› find_context(query: "launch checklist status page")
1 result(s) for "launch checklist status page", ~37/3500 tokens
<untrusted_content source="find_context">
[1] Q4 launch plan › Checklist
(page 3e8a2ebe; §checklist v=11d46ddf8928; can: read,comment,suggest; edited by Priya Nair)
- [x] Pricing page copy
- [ ] Status page, owner Sam Ortiz, due 2026-11-20
- [ ] Support macros for the new plans
</untrusted_content>

Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.

› patch_section(pageId: "3e8a2ebe", section: "checklist", mode: "append",
    markdown: "- [ ] Schedule the launch retro", baseVersion: "11d46ddf8928")
Not written: kept as suggestion a41c07e2 for §checklist of page 3e8a2ebe (append), because this page is locked to "agents: suggestions only".
A person with edit access accepts or rejects it in the web app; the result arrives in inbox as approval_result.
list_suggestions(pageId) shows it; withdraw_suggestion(id) takes it back; a new suggestion from this connection for the same section replaces it.

# (person) looks at the changed lines in the web app and accepts or rejects. Accepting updates the section and adds an AI edit to the history; rejecting leaves the note as it is
```

In the product the same happens when the workspace is set to "review everything" or the agent passes `suggest=true`, and the decision reaches the agent's inbox as approval_result.

- [MCP guide: Suggestions, edit policy and claims](../docs/MCP.md)
- [User guide: Reviewing what agents suggest](../docs/GUIDE.md)

## 5. Edit lock

When a page is locked with agents set to "comment only", an agent's write is refused with PAGE_LOCKED. Press the lock button above the note, then run.

```text
# (person) locks this page with agents set to "comment only"

› find_context(query: "launch checklist status page")
1 result(s) for "launch checklist status page", ~37/3500 tokens
<untrusted_content source="find_context">
[1] Q4 launch plan › Checklist
(page 3e8a2ebe; §checklist v=11d46ddf8928; can: read,comment; edited by Priya Nair)
- [x] Pricing page copy
- [ ] Status page, owner Sam Ortiz, due 2026-11-20
- [ ] Support macros for the new plans
</untrusted_content>

Next: read_page(pageId, section=anchor) for a full section; read_page(pageId, outline=true) for structure.

› patch_section(pageId: "3e8a2ebe", section: "checklist", mode: "append",
    markdown: "- [ ] Update the plan comparison table", baseVersion: "11d46ddf8928")
"Q4 launch plan" is locked for agents (comment only). A person must make this edit in the web app; you can add a comment with the suggested change. (PAGE_LOCKED): nothing was written; do not retry or work around the lock (moving or copying the page will not help). Tell the user who can edit it, or leave your suggested change with add_comment if that is allowed (see the can: line of read_page)
```

Only people change locks. Agents have no tool for it, and the refusal tells the agent to inform a person instead of working around the lock.

- [MCP guide: Workspace instructions, locks and untrusted content](../docs/MCP.md)
- [User guide: Edit lock](../docs/GUIDE.md)

## Next

- [Install it yourself](../docs/DEPLOY.md): How to put Inkling on your own server. There is also a local trial on your computer.
- [Connect your Claude](../docs/MCP.md): How to connect Claude Code, claude.ai and other MCP clients to Inkling.
