CREATE TABLE "workspace_list_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"collapsed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_listings" (
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"group_id" uuid,
	"position" integer,
	"archived_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_listings_user_id_workspace_id_pk" PRIMARY KEY("user_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_list_groups" ADD CONSTRAINT "workspace_list_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_listings" ADD CONSTRAINT "workspace_listings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_listings" ADD CONSTRAINT "workspace_listings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_listings" ADD CONSTRAINT "workspace_listings_group_id_workspace_list_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."workspace_list_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_list_groups_user_idx" ON "workspace_list_groups" USING btree ("user_id","position");--> statement-breakpoint
CREATE INDEX "workspace_listings_group_idx" ON "workspace_listings" USING btree ("group_id");