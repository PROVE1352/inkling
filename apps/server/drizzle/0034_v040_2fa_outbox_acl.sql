CREATE TABLE "workspace_acl_versions" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"locked_pages" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "totp_login_challenges" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"password_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_recovery_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_totp" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_enc" text NOT NULL,
	"enabled_at" timestamp with time zone,
	"last_used_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_feed_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"high_water" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"dedupe_key" text,
	"origin" text,
	"workspace_id" uuid,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspace_acl_versions" ADD CONSTRAINT "workspace_acl_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_login_challenges" ADD CONSTRAINT "totp_login_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_totp" ADD CONSTRAINT "user_totp_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "totp_login_challenges_user_idx" ON "totp_login_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "totp_login_challenges_expires_idx" ON "totp_login_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_recovery_codes_user_idx" ON "user_recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("topic","id") WHERE state = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_finished_idx" ON "outbox" USING btree ("finished_at") WHERE state <> 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_key" ON "outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "pages_ws_locked_idx" ON "pages" USING btree ("workspace_id") WHERE "pages"."edit_locked";--> statement-breakpoint
CREATE INDEX "workspace_audit_ws_created_idx" ON "workspace_audit_events" USING btree ("workspace_id","created_at");