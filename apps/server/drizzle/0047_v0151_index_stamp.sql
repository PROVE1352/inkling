ALTER TABLE "page_chunk_index" ADD COLUMN "doc_updated_at" timestamp with time zone;--> statement-breakpoint
-- Existing indexes count as current (docs/adr/1924-*): the release before stopped gracefully and
-- flushed its queued index passes, so the first boot of 0.15.1 does not re-index the instance.
UPDATE "page_chunk_index" ci SET "doc_updated_at" = d."updated_at" FROM "page_docs" d WHERE d."page_id" = ci."page_id";
