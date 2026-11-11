ALTER TABLE "pages" ADD COLUMN "share_include_charts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "share_charts_by" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "share_chart_sources" jsonb;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_share_charts_by_users_id_fk" FOREIGN KEY ("share_charts_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;