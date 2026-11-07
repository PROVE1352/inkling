CREATE TABLE "bookmarks" (
	"user_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"sort_order" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmarks_user_id_page_id_pk" PRIMARY KEY("user_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "page_tags" (
	"page_id" uuid NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "page_tags_page_id_tag_pk" PRIMARY KEY("page_id","tag")
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "properties" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "cover_url" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "is_template" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tags" ADD CONSTRAINT "page_tags_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_tags_tag_idx" ON "page_tags" USING btree ("tag");