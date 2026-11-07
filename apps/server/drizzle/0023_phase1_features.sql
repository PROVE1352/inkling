CREATE TABLE "plugin_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"approved_version" text,
	"approved_permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_hash" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plugin_storage" (
	"plugin_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"bytes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_storage_plugin_id_user_id_key_pk" PRIMARY KEY("plugin_id","user_id","key")
);
--> statement-breakpoint
CREATE TABLE "collection_sheet_syncs" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"url" text NOT NULL,
	"key_column" text NOT NULL,
	"title_column" text,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"last_synced_at" timestamp with time zone,
	"running_since" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"last_stats" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ical_tokens" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "ical_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "page_sync_hashes" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"revision" text NOT NULL,
	"content_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" text DEFAULT '1' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_success_at" timestamp with time zone,
	"auto_disabled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_installs" ADD CONSTRAINT "plugin_installs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_storage" ADD CONSTRAINT "plugin_storage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_sheet_syncs" ADD CONSTRAINT "collection_sheet_syncs_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_sheet_syncs" ADD CONSTRAINT "collection_sheet_syncs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_sheet_syncs" ADD CONSTRAINT "collection_sheet_syncs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ical_tokens" ADD CONSTRAINT "ical_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_sync_hashes" ADD CONSTRAINT "page_sync_hashes_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_webhooks" ADD CONSTRAINT "workspace_webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_webhooks" ADD CONSTRAINT "workspace_webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_sheet_syncs_due_idx" ON "collection_sheet_syncs" USING btree ("enabled","last_synced_at");--> statement-breakpoint
CREATE INDEX "workspace_webhooks_ws_idx" ON "workspace_webhooks" USING btree ("workspace_id");