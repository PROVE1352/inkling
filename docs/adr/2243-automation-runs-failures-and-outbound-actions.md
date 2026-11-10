# 2243. Automation runs are logged, failing rules turn off, outbound actions use registered webhooks

- Status: Accepted
- Date: 2026-11-10

## Context
People need to see what a rule did and why it did not; a rule pointing at a deleted database must not
fail forever; and a rule (or a button) must be able to tell another system without becoming a way to send
workspace data to any URL typed into a page.

## Decision
- **Runs**: `automation_runs` keeps the newest 50 per rule: time, row, status (`ok` / `failed` /
  `skipped`), the failed action's index, the reason (the REST error message, capped at 300 characters),
  who triggered it and the depth. Not recorded: runs of a rule turned off meanwhile, and runs whose "to"
  value or condition does not match (most changes do not concern a rule). GET
  /collections/:id/automations/runs serves them.
- **Failed or skipped**: the first action that cannot run stops the run. *Failed* is what the author can
  fix — a target database or field gone, rights lost (a REST refusal), a webhook removed or off, a full
  webhook queue. *Skipped* is nothing to do for this row (no one to notify or assign, values that did not
  resolve) or a refusal by the trigger's cap (ADR 2241); skips never count.
- **Failures**: five failed runs in a row
  (`AUTOMATION_DISABLE_AFTER`) turn the rule off (`auto_disabled_at`) and send its author one direct
  notification (`doc_mention` on the database page, like a mention). A success resets the streak; turning
  the rule on by hand resets it too, after the rule is checked again.
- **Notify action**: a `doc_mention` notification per recipient (people in a person field, the row's
  creator, or named members), only to members who can see the row, with "<rule>: <message>" as excerpt;
  the triggering person is the actor, so they do not notify themselves. It follows the recipient's
  notification settings and caps like any mention.
- **Outbound**: a rule or a button names one webhook registered by a workspace owner (Slack, Discord or
  generic, ADR 0504, 1190) by id, never a URL. The delivery uses the existing outbox, retries, delivery log
  and auto-disable; the event type is `automation` (not subscribable, so existing hooks get nothing new),
  with the rule's name or button's label and an optional message. A Slack channel message is a Slack
  webhook; posting through the Slack app (ADR 1800) is not a v1 action.
- Members pick hooks from GET /workspaces/:id/webhook-targets: kind and host only.

## Alternatives considered
- **Arbitrary URL per action**: an editor could send row contents anywhere, past the owner-only webhook
  setting.
- **Slack app channel posts**: one channel per workspace, already used for mentions and digests; adding
  rule posts there needs its own event kind and settings UI. Left for later.
- **Keep every run**: unbounded rows for a busy rule; 50 is what the settings screen shows.

## Consequences
- automations/runner.ts (`record`), webhooks.ts (`automation` event: Slack/Discord text and generic JSON
  with `field` and `message`), packages/shared embeds.ts (`WebhookEvent`).
