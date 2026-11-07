CREATE TABLE "collection_row_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"title" text DEFAULT '' NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "bytea",
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"hook_id" uuid NOT NULL,
	"outbox_id" bigint,
	"event" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"status_code" integer,
	"error" text,
	"duration_ms" integer,
	"response_excerpt" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scope" text NOT NULL,
	"range_kind" text,
	"range_workspace_ids" uuid[],
	"range_page_id" uuid,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD COLUMN "range_kind" text;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD COLUMN "range_workspace_ids" uuid[];--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD COLUMN "range_page_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "range_kind" text;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "range_workspace_ids" uuid[];--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "range_page_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_webhooks" ADD COLUMN "failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_webhooks" ADD COLUMN "secret" text;--> statement-breakpoint
ALTER TABLE "workspace_webhooks" ADD COLUMN "previous_secret" text;--> statement-breakpoint
ALTER TABLE "workspace_webhooks" ADD COLUMN "previous_secret_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "collection_row_templates" ADD CONSTRAINT "collection_row_templates_collection_id_pages_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_row_templates" ADD CONSTRAINT "collection_row_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_hook_id_workspace_webhooks_id_fk" FOREIGN KEY ("hook_id") REFERENCES "public"."workspace_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_row_templates_coll_idx" ON "collection_row_templates" USING btree ("collection_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_row_templates_default_uq" ON "collection_row_templates" USING btree ("collection_id") WHERE "collection_row_templates"."is_default";--> statement-breakpoint
CREATE INDEX "webhook_deliveries_hook_idx" ON "webhook_deliveries" USING btree ("hook_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_outbox_key" ON "webhook_deliveries" USING btree ("outbox_id");--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");