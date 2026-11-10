-- Optional semantic search (docs/adr/1740-*): chunk embeddings as real[]; written only when EMBEDDING_URL and EMBEDDING_MODEL are set.
CREATE TABLE "page_chunk_vectors" (
	"page_id" uuid NOT NULL,
	"text_hash" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"model" text NOT NULL,
	"dims" integer NOT NULL,
	"embedding" real[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_chunk_vectors_page_id_text_hash_pk" PRIMARY KEY("page_id","text_hash")
);
--> statement-breakpoint
ALTER TABLE "page_chunk_vectors" ADD CONSTRAINT "page_chunk_vectors_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_chunk_vectors" ADD CONSTRAINT "page_chunk_vectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_chunk_vectors_workspace_idx" ON "page_chunk_vectors" USING btree ("workspace_id","updated_at");