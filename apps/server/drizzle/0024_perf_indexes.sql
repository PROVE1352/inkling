-- docs/adr/0755-*: indexes from hand-written 0007/0009 are now declared in the drizzle schema
-- (a `drizzle-kit push` against production had dropped them). IF NOT EXISTS keeps this a no-op
-- where they survived and recreates them where they did not. pg_trgm comes from 0007.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_workspace_idx" ON "files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "files_page_idx" ON "files" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_links_target_idx" ON "page_links" USING btree ("target_page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_texts_text_trgm_idx" ON "page_texts" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_workspace_deleted_idx" ON "pages" USING btree ("workspace_id","deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_parent_idx" ON "pages" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_created_by_idx" ON "pages" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_title_trgm_idx" ON "pages" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");
--> statement-breakpoint
-- HOT updates: every document store bumps pages.updated_at; on packed heap pages that update
-- rewrote all eight indexes (incl. the GIN trigram index). Measured on 5k pages: 0.1% → 91% HOT
-- after a table rewrite. Takes effect for newly written pages (see docs/OPERATIONS.md).
ALTER TABLE "pages" SET (fillfactor = 85);--> statement-breakpoint
ALTER TABLE "page_docs" SET (fillfactor = 90);
