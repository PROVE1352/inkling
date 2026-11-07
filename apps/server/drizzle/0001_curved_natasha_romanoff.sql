CREATE TABLE "page_links" (
	"source_page_id" uuid NOT NULL,
	"target_page_id" uuid NOT NULL,
	CONSTRAINT "page_links_source_page_id_target_page_id_pk" PRIMARY KEY("source_page_id","target_page_id")
);
--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_source_page_id_pages_id_fk" FOREIGN KEY ("source_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_target_page_id_pages_id_fk" FOREIGN KEY ("target_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;