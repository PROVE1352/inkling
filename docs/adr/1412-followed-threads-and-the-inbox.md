# 1412. Followed comment threads, the Threads view and the reply notification

- Status: Accepted
- Date: 2026-11-09

## Context
Before this, a reply in a comment thread notified the thread's earlier authors (`comment_reply`,
computed from `comments.author_id` at post time). Nobody could follow a thread they had not written
in, nor stop hearing about one they had. The bell collapses replies per thread (`cr:<thread>`), and
the agent inbox (1003) lists the same rows as `reply`. Slack separates "Threads" (every followed
thread with new replies) from "Activity" (mentions and reactions).

What the person sees today, so the new view does not duplicate it:
- Bell: `comment_mention` (`cm:<thread>`), `comment_reply` (`cr:<thread>`), `comment` for page
  creators/owners and followers of the page (`c:<thread>`), one unread row per thread and kind.
- Agent inbox: the same rows as `mention`, `reply`, `comment`.

## Decision
- **Follow rows** (`thread_follows`, one per person and thread): `following`, `source` (`auto` |
  `manual`), `last_read_at`. Starting or replying in a thread writes `auto` in the comment's own
  statement (`ON CONFLICT DO NOTHING`, so an unfollow sticks) unless the person turned
  `thread_auto_follow` off, and reads the thread up to now. The follow button writes `manual`.
- **Reply notification = followers:** `comment_reply` goes to the thread's followers whose
  `thread_replies` setting is on, instead of its earlier authors. Mentions are unchanged (a person
  who unfollowed still gets `comment_mention`); page creators and page followers keep `comment`.
  The engine still keeps one row per person (highest kind) and collapses per thread.
- **Migration backfill** (`0039_v011_later_threads.sql`): every earlier author of a thread follows
  it (`auto`, `last_read_at = now()`), so replies reach the same people as before and nothing old
  shows up as new.
- **Threads view** (`GET /threads?workspaceId=`; sidebar "Threads" with a count): followed threads
  with replies by someone else newer than `last_read_at`, newest activity first, new-reply count,
  root excerpt, last reply preview; `all=1` adds the read ones (to unfollow). Computed from
  `comments` at read time; pages the person cannot see are left out.
- **One read mark, two places:** opening a thread from the view (`POST /threads/:id/read`) reads it
  and marks the bell rows of that thread read (`cr:`, `c:`, `cm:` keys). Opening a single comment
  item in the bell (`POST /notifications/read` with ids) reads its thread in the view. "Mark all
  read" in the bell does not empty the view: the view is the list of what is left to read.
- **Settings** (Settings → Notifications, browser only like the rest): "Follow threads I start or
  reply in" and "Notify me about replies in threads I follow". With the second off, replies only
  show in the Threads view.
- The agent inbox is unchanged: `reply` now means "a reply in a thread the person follows".

## Alternatives considered
- **A new kind `thread_reply`** next to `comment_reply`: two rows for the same reply in the bell
  and the inbox, or a priority rule to drop one; the existing kind already means this.
- **Threads view from notifications** (unread `cr:` rows): loses replies when the setting is off or
  the hourly cap made them quiet, and "mark all read" would clear it.
- **Auto-follow by reading:** too broad; Slack follows on writing and on mention only.
- **Follow on mention:** a mention already notifies directly; following would add every later reply.
  Left out; the person can follow by hand.

## Trade-offs
- A comment POST writes up to two more rows in its statement (follow insert, read-mark update);
  the follower lookup reads `thread_follows` instead of `comments` (indexed by thread).
- People who used to hear about a thread because they wrote in it keep hearing about it only
  through the backfill; a restore of a pre-0.11 backup into 0.11 runs the backfill again.
- Guests follow and see the view (inside their shared trees); the engine still does not notify
  guests (1000).

## Consequences
- New routes `GET /threads`, `GET/PUT /threads/:id/follow`, `POST /threads/:id/read`,
  `GET /pages/:id/thread-follows`; `GET/PATCH /me/notification-settings` gain `threadAutoFollow`,
  `threadReplies`.
- Tests: `apps/server/src/later.db.test.ts` (auto/manual/unfollow, settings, view order and counts,
  read marks both ways, visibility, backfill), `guests.db.test.ts`.

## References
- apps/server/src/routes/threads.ts, routes/comments.ts (`commentContext`, `insertCommentWithEvents`)
- apps/web/src/pages/ThreadsView.tsx, components/comments/CommentsPanel.tsx
