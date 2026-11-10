-- Slack app per workspace (docs/adr/1800-*): bot token + signing secret (sealed with APP_SECRET_KEY when set), Slack account links, one-time link codes, replay guard.
CREATE TABLE "slack_integrations" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"bot_token" text NOT NULL,
	"bot_token_hint" text NOT NULL,
	"signing_secret" text NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text,
	"bot_user_id" text,
	"channel_id" text NOT NULL,
	"channel_name" text,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" text DEFAULT '1' NOT NULL,
	"blocked_reason" text,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"digest_sent_on" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_link_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_request_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_user_links" (
	"workspace_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_user_links_workspace_id_team_id_slack_user_id_pk" PRIMARY KEY("workspace_id","team_id","slack_user_id")
);
--> statement-breakpoint
ALTER TABLE "slack_integrations" ADD CONSTRAINT "slack_integrations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_integrations" ADD CONSTRAINT "slack_integrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_link_codes" ADD CONSTRAINT "slack_link_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_user_links" ADD CONSTRAINT "slack_user_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slack_link_codes_expires_idx" ON "slack_link_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "slack_request_nonces_seen_idx" ON "slack_request_nonces" USING btree ("seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_user_links_user_key" ON "slack_user_links" USING btree ("workspace_id","user_id");