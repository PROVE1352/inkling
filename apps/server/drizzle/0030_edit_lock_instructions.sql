CREATE TABLE "agent_instructions" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"apply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_access_overrides" (
	"page_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid,
	"allow" smallint DEFAULT 0 NOT NULL,
	"deny" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_access_overrides_page_id_subject_pk" PRIMARY KEY("page_id","subject")
);
--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "tainted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "page_chunks" ADD COLUMN "suspicious" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "edit_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_instructions" ADD CONSTRAINT "agent_instructions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instructions" ADD CONSTRAINT "agent_instructions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instructions" ADD CONSTRAINT "agent_instructions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_access_overrides" ADD CONSTRAINT "page_access_overrides_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_access_overrides" ADD CONSTRAINT "page_access_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_instructions_ws_idx" ON "agent_instructions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "page_access_overrides_user_idx" ON "page_access_overrides" USING btree ("user_id");