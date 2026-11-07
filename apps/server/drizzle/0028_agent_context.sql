CREATE TABLE "page_changes" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"anchor" text,
	"prev_anchor" text,
	"heading_path" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"before_text" text,
	"after_text" text,
	"large" boolean DEFAULT false NOT NULL,
	"scope" text NOT NULL,
	"owner_id" uuid,
	"actor_id" uuid,
	"via_client" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_chunk_index" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_chunks" (
	"page_id" uuid NOT NULL,
	"ord" integer NOT NULL,
	"workspace_id" uuid NOT NULL,
	"anchor" text NOT NULL,
	"block_id" text,
	"heading_path" text DEFAULT '' NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"part" integer DEFAULT 0 NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"grams" text DEFAULT '' NOT NULL,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"hash" text NOT NULL,
	"section_hash" text NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, heading_path || ' ' || text || ' ' || grams)) STORED NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_chunks_page_id_ord_pk" PRIMARY KEY("page_id","ord")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "via_client" text;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD COLUMN "via_client" text;--> statement-breakpoint
ALTER TABLE "page_changes" ADD CONSTRAINT "page_changes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_chunk_index" ADD CONSTRAINT "page_chunk_index_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_chunks" ADD CONSTRAINT "page_chunks_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_chunks" ADD CONSTRAINT "page_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_changes_ws_seq_idx" ON "page_changes" USING btree ("workspace_id","seq");--> statement-breakpoint
CREATE INDEX "page_changes_page_idx" ON "page_changes" USING btree ("page_id","anchor","seq");--> statement-breakpoint
CREATE INDEX "page_changes_changed_idx" ON "page_changes" USING btree ("changed_at");--> statement-breakpoint
CREATE INDEX "page_chunks_workspace_idx" ON "page_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "page_chunks_tsv_idx" ON "page_chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "page_chunks_text_trgm_idx" ON "page_chunks" USING gin ("text" gin_trgm_ops);