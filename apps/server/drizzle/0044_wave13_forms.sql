-- Public links of form views (docs/adr/1821-*). Formula fields and form views need no column: both live in the collection's jsonb.
CREATE TABLE "collection_form_links" (
	"view_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"token_enc" text,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_form_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "collection_form_links" ADD CONSTRAINT "collection_form_links_view_id_collection_views_id_fk" FOREIGN KEY ("view_id") REFERENCES "public"."collection_views"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_form_links" ADD CONSTRAINT "collection_form_links_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
