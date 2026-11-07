CREATE TABLE "page_reads" (
	"page_id" uuid NOT NULL,
	"day" date NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "page_reads_page_id_day_pk" PRIMARY KEY("page_id","day")
);
--> statement-breakpoint
CREATE TABLE "page_review_scores" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reads30" integer DEFAULT 0 NOT NULL,
	"lambda" double precision NOT NULL,
	"p_stale" double precision NOT NULL,
	"score" double precision NOT NULL,
	"due_on" text NOT NULL,
	"est_minutes" integer DEFAULT 1 NOT NULL,
	"living" boolean DEFAULT false NOT NULL,
	"archive_candidate" boolean DEFAULT false NOT NULL,
	"computed_on" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_access" (
	"workspace_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"first_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_agent_access_workspace_id_grant_id_pk" PRIMARY KEY("workspace_id","grant_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text,
	"client_name" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_agent_blocks_uniq" UNIQUE NULLS NOT DISTINCT("workspace_id","user_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_name" text DEFAULT '' NOT NULL,
	"via_client" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"target_label" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "living_override" boolean;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "invite_link_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "member_add_policy" text DEFAULT 'admins' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "export_policy" text DEFAULT 'members' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "public_sharing_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "trash_retention_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "audit_retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "review_interval_days" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "review_digest_sent_on" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "review_scored_on" text;--> statement-breakpoint
ALTER TABLE "page_reads" ADD CONSTRAINT "page_reads_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_review_scores" ADD CONSTRAINT "page_review_scores_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_review_scores" ADD CONSTRAINT "page_review_scores_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_access" ADD CONSTRAINT "workspace_agent_access_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_access" ADD CONSTRAINT "workspace_agent_access_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_access" ADD CONSTRAINT "workspace_agent_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_access" ADD CONSTRAINT "workspace_agent_access_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_blocks" ADD CONSTRAINT "workspace_agent_blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_blocks" ADD CONSTRAINT "workspace_agent_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_blocks" ADD CONSTRAINT "workspace_agent_blocks_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_agent_blocks" ADD CONSTRAINT "workspace_agent_blocks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_audit_events" ADD CONSTRAINT "workspace_audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_audit_events" ADD CONSTRAINT "workspace_audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_reads_day_idx" ON "page_reads" USING btree ("day");--> statement-breakpoint
CREATE INDEX "page_review_scores_ws_score_idx" ON "page_review_scores" USING btree ("workspace_id","score");--> statement-breakpoint
CREATE INDEX "workspace_audit_ws_id_idx" ON "workspace_audit_events" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "workspace_audit_ws_action_idx" ON "workspace_audit_events" USING btree ("workspace_id","action","id");--> statement-breakpoint
CREATE INDEX "workspace_audit_created_idx" ON "workspace_audit_events" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pages_owner_idx" ON "pages" USING btree ("owner_id");