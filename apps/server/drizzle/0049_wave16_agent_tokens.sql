ALTER TABLE "oauth_grants" ADD COLUMN "kind" text DEFAULT 'oauth' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "token_prefix" text;