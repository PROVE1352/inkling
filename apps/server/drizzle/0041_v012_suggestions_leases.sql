CREATE TABLE "agent_edit_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid,
	"level" text DEFAULT 'direct' NOT NULL,
	"modes" jsonb DEFAULT '["append","insert_after","prepend"]'::jsonb NOT NULL,
	"connections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_lines" integer,
	"max_chars" integer,
	"grace_minutes" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catch_up_markers" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"cursor" text NOT NULL,
	"seq" bigint NOT NULL,
	"at" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catch_up_markers_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "section_leases" (
	"page_id" uuid NOT NULL,
	"anchor" text NOT NULL,
	"block_id" text,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connection" text NOT NULL,
	"via" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "section_leases_page_id_anchor_pk" PRIMARY KEY("page_id","anchor")
);
--> statement-breakpoint
CREATE TABLE "section_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"anchor" text NOT NULL,
	"block_id" text,
	"heading_path" text DEFAULT '' NOT NULL,
	"base_version" text,
	"markdown" text NOT NULL,
	"mode" text NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"author_id" uuid NOT NULL,
	"via" text,
	"connection" text DEFAULT '' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"rule" text,
	"review_reason" text,
	"auto_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_edit_policies" ADD CONSTRAINT "agent_edit_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_edit_policies" ADD CONSTRAINT "agent_edit_policies_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_edit_policies" ADD CONSTRAINT "agent_edit_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catch_up_markers" ADD CONSTRAINT "catch_up_markers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_leases" ADD CONSTRAINT "section_leases_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_leases" ADD CONSTRAINT "section_leases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_leases" ADD CONSTRAINT "section_leases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_suggestions" ADD CONSTRAINT "section_suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_suggestions" ADD CONSTRAINT "section_suggestions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_suggestions" ADD CONSTRAINT "section_suggestions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "section_suggestions" ADD CONSTRAINT "section_suggestions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_edit_policies_ws_key" ON "agent_edit_policies" USING btree ("workspace_id") WHERE page_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_edit_policies_page_key" ON "agent_edit_policies" USING btree ("page_id") WHERE page_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "section_leases_expires_idx" ON "section_leases" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "section_suggestions_auto_idx" ON "section_suggestions" USING btree ("auto_at") WHERE status = 'open' AND auto_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "section_suggestions_page_open_idx" ON "section_suggestions" USING btree ("page_id","created_at") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "section_suggestions_author_idx" ON "section_suggestions" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "section_suggestions_open_key" ON "section_suggestions" USING btree ("page_id","anchor","author_id","connection") WHERE status = 'open';--> statement-breakpoint
-- catch_up markers move out of plugin_storage (docs/adr/1537-*, replaces 1522-*). Hand-written:
-- rows that are not JSON objects with a string cursor are dropped with the rest (unreadable anyway).
-- The jsonb cast is guarded in a CASE (AND does not fix the evaluation order).
INSERT INTO "catch_up_markers" ("user_id", "key", "cursor", "seq", "at", "updated_at")
SELECT s."user_id", s."key", s.v ->> 'cursor',
       coalesce(trunc((s.v ->> 'seq')::numeric)::bigint, 0), coalesce(trunc((s.v ->> 'at')::numeric)::bigint, 0), s."updated_at"
  FROM (SELECT "user_id", "key", "updated_at",
               CASE WHEN pg_input_is_valid("value", 'jsonb') THEN "value"::jsonb END AS v
          FROM "plugin_storage" WHERE "plugin_id" = 'inkling:catch_up') s
 WHERE jsonb_typeof(s.v) = 'object'
   AND jsonb_typeof(s.v -> 'cursor') = 'string'
   AND coalesce(jsonb_typeof(s.v -> 'seq'), 'number') = 'number'
   AND coalesce(jsonb_typeof(s.v -> 'at'), 'number') = 'number'
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "plugin_storage" WHERE "plugin_id" = 'inkling:catch_up';
