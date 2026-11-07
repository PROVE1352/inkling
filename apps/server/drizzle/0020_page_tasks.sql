CREATE TABLE "page_task_index" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"due" text NOT NULL,
	"checked" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_task_index" ADD CONSTRAINT "page_task_index_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tasks" ADD CONSTRAINT "page_tasks_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tasks" ADD CONSTRAINT "page_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_tasks_ws_due_idx" ON "page_tasks" USING btree ("workspace_id","due");--> statement-breakpoint
CREATE INDEX "page_tasks_page_idx" ON "page_tasks" USING btree ("page_id");