CREATE TABLE "page_rotations" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"mode" text,
	"max_bytes" integer DEFAULT 1048576 NOT NULL,
	"current_page_id" uuid,
	"current_key" text,
	"hinted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_login_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"browser_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"return_to" text NOT NULL,
	"link_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "user_identities_issuer_subject_pk" PRIMARY KEY("issuer","subject")
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "share_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "share_password_hash" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "share_default_expiry_days" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "share_password_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "page_rotations" ADD CONSTRAINT "page_rotations_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_rotations" ADD CONSTRAINT "page_rotations_current_page_id_pages_id_fk" FOREIGN KEY ("current_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_login_states" ADD CONSTRAINT "oidc_login_states_link_user_id_users_id_fk" FOREIGN KEY ("link_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oidc_login_states_expires_idx" ON "oidc_login_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_user_issuer_uq" ON "user_identities" USING btree ("user_id","issuer");