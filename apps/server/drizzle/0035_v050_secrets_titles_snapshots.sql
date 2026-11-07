CREATE TABLE "page_former_titles" (
	"workspace_id" uuid NOT NULL,
	"title_key" text NOT NULL,
	"page_id" uuid NOT NULL,
	"title" text NOT NULL,
	"renamed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_former_titles_workspace_id_title_key_page_id_pk" PRIMARY KEY("workspace_id","title_key","page_id")
);
--> statement-breakpoint
ALTER TABLE "page_docs" ADD COLUMN "state_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "page_docs" ADD COLUMN "state_vector" "bytea";--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "state_format" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "base_id" uuid;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "depth" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "state_vector" "bytea";--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "share_token_enc" text;--> statement-breakpoint
ALTER TABLE "signup_keys" ADD COLUMN "key_enc" text;--> statement-breakpoint
ALTER TABLE "signup_keys" ADD COLUMN "key_hint" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "invite_code_enc" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "two_factor_required_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "two_factor_grace_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "page_former_titles" ADD CONSTRAINT "page_former_titles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_former_titles" ADD CONSTRAINT "page_former_titles_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_former_titles_page_idx" ON "page_former_titles" USING btree ("page_id");