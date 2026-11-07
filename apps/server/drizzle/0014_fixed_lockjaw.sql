ALTER TABLE "pages" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_share_token_unique" UNIQUE("share_token");