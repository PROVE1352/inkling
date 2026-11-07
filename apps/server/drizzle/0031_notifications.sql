CREATE TABLE "notification_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"root_page_id" uuid,
	"level" text NOT NULL,
	"subtree" boolean DEFAULT true NOT NULL,
	"agent_digest" boolean DEFAULT false NOT NULL,
	"agent_digest_sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_user_root_key" UNIQUE NULLS NOT DISTINCT("user_id","workspace_id","root_page_id")
);
--> statement-breakpoint
CREATE TABLE "page_mentions" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"user_ids" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_notification_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email_instant" boolean DEFAULT true NOT NULL,
	"email_digest" text DEFAULT 'daily' NOT NULL,
	"digest_sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "via_client" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "delivery" text DEFAULT 'now' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "mail_state" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "group_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "excerpt" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "anchor" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "acked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "agent_digest_sent_on" text;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_root_page_id_pages_id_fk" FOREIGN KEY ("root_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_mentions" ADD CONSTRAINT "page_mentions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notification_settings" ADD CONSTRAINT "user_notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_prefs_root_idx" ON "notification_prefs" USING btree ("root_page_id");--> statement-breakpoint
CREATE INDEX "notification_prefs_digest_idx" ON "notification_prefs" USING btree ("workspace_id") WHERE agent_digest;--> statement-breakpoint
CREATE INDEX "notifications_user_seq_idx" ON "notifications" USING btree ("user_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_group_unread_idx" ON "notifications" USING btree ("user_id","group_key") WHERE read = '0' AND group_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notifications_mail_idx" ON "notifications" USING btree ("mail_state") WHERE mail_state IN ('instant', 'digest');--> statement-breakpoint
CREATE INDEX "page_changes_page_seq_idx" ON "page_changes" USING btree ("page_id","seq");--> statement-breakpoint
-- Pages that existed before body mentions were tracked: baseline unknown (user_ids NULL), so the first index pass records their mentions without notifying (docs/adr/1002-*).
INSERT INTO "page_mentions" ("page_id", "user_ids") SELECT "id", NULL FROM "pages" WHERE "kind" = 'doc' ON CONFLICT DO NOTHING;
