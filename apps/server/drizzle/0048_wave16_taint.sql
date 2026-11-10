CREATE TABLE "connection_taints" (
	"connection" text NOT NULL,
	"source" text NOT NULL,
	"page_id" uuid,
	"workspace_id" uuid NOT NULL,
	"rules" text[] DEFAULT '{}'::text[] NOT NULL,
	"fingerprint" text NOT NULL,
	"tainted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid,
	CONSTRAINT "connection_taints_connection_source_pk" PRIMARY KEY("connection","source")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "agent_taint_demote" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_taints" ADD CONSTRAINT "connection_taints_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_taints" ADD CONSTRAINT "connection_taints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_taints" ADD CONSTRAINT "connection_taints_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_taints_workspace_idx" ON "connection_taints" USING btree ("workspace_id");