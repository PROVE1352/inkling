CREATE TABLE "later_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"page_id" uuid NOT NULL,
	"thread_id" uuid,
	"notification_id" uuid,
	"anchor" text,
	"target_key" text NOT NULL,
	"done_at" timestamp with time zone,
	"remind_at" timestamp with time zone,
	"remind_tz" text,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_follows" (
	"user_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"following" boolean DEFAULT true NOT NULL,
	"source" text NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_follows_user_id_thread_id_pk" PRIMARY KEY("user_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "user_notification_settings" ADD COLUMN "thread_auto_follow" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_settings" ADD COLUMN "thread_replies" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "later_items" ADD CONSTRAINT "later_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "later_items" ADD CONSTRAINT "later_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "later_items" ADD CONSTRAINT "later_items_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "later_items" ADD CONSTRAINT "later_items_thread_id_comments_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "later_items" ADD CONSTRAINT "later_items_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_thread_id_comments_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_follows" ADD CONSTRAINT "thread_follows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "later_items_user_target_key" ON "later_items" USING btree ("user_id","target_key");--> statement-breakpoint
CREATE INDEX "later_items_user_created_idx" ON "later_items" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "later_items_due_idx" ON "later_items" USING btree ("remind_at") WHERE remind_at IS NOT NULL AND reminded_at IS NULL AND done_at IS NULL;--> statement-breakpoint
CREATE INDEX "later_items_page_idx" ON "later_items" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "thread_follows_thread_idx" ON "thread_follows" USING btree ("thread_id") WHERE following;--> statement-breakpoint
CREATE INDEX "thread_follows_user_ws_idx" ON "thread_follows" USING btree ("user_id","workspace_id") WHERE following;--> statement-breakpoint
-- Backfill (docs/adr/1412-*, hand-written): everyone who wrote in a thread follows it, so replies keep
-- reaching the thread's earlier authors as before this release (comment_reply went to them).
-- last_read_at = now(): no old reply shows up as new in the Threads view after the upgrade.
INSERT INTO "thread_follows" ("user_id", "thread_id", "page_id", "workspace_id", "following", "source", "last_read_at")
SELECT DISTINCT ON (c.author_id, c.thread_id) c.author_id, c.thread_id, c.page_id, p.workspace_id, true, 'auto', now()
  FROM "comments" c
  JOIN "pages" p ON p.id = c.page_id
 WHERE c.author_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM "comments" r WHERE r.id = c.thread_id)
 ORDER BY c.author_id, c.thread_id
ON CONFLICT DO NOTHING;
