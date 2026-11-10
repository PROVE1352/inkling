ALTER TABLE "files" ADD COLUMN "uploaded_via" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "agent_uploads" text;--> statement-breakpoint
CREATE INDEX "files_agent_uploads_idx" ON "files" USING btree ("created_by","created_at") WHERE "files"."uploaded_via" IS NOT NULL;