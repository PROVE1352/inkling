-- Scheduled public links (docs/adr/1844-*), page verification (docs/adr/1840-*), member status (docs/adr/1845-*).
ALTER TABLE "pages" ADD COLUMN "share_starts_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "page_verifications" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"base_seq" bigint DEFAULT 0 NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "user_statuses" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"emoji" text,
	"text" text DEFAULT '' NOT NULL,
	"clear_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_verifications" ADD CONSTRAINT "page_verifications_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_verifications" ADD CONSTRAINT "page_verifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_verifications" ADD CONSTRAINT "page_verifications_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_statuses" ADD CONSTRAINT "user_statuses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_verifications_ws_expires_idx" ON "page_verifications" USING btree ("workspace_id","expires_at");
