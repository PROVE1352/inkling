ALTER TABLE "workspace_members" ADD COLUMN "agents_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "added_by" uuid;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_members_agents_pending_idx" ON "workspace_members" USING btree ("user_id") WHERE "workspace_members"."agents_pending";