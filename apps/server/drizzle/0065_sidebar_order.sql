ALTER TABLE "pages" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "child_sort" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "private_child_sort" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "root_child_sort" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "agent_default_parent_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "created_via" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_agent_default_parent_id_pages_id_fk" FOREIGN KEY ("agent_default_parent_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;