CREATE TABLE "automation_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"automation_id" uuid NOT NULL,
	"row_id" uuid,
	"status" text NOT NULL,
	"failed_action" smallint,
	"error" text,
	"actor_id" uuid,
	"depth" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" jsonb NOT NULL,
	"condition" jsonb,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"auto_disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_collection_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."collection_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_automations" ADD CONSTRAINT "collection_automations_collection_id_pages_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_automations" ADD CONSTRAINT "collection_automations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_automations" ADD CONSTRAINT "collection_automations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_runs_rule_idx" ON "automation_runs" USING btree ("automation_id","id");--> statement-breakpoint
CREATE INDEX "collection_automations_coll_idx" ON "collection_automations" USING btree ("collection_id") WHERE "collection_automations"."enabled";