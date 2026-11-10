ALTER TABLE "page_snapshots" ADD COLUMN "digest" text;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "step" jsonb;