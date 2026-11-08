CREATE TABLE "page_grants" (
	"page_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"level" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_grants_page_id_user_id_pk" PRIMARY KEY("page_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "page_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"email" text NOT NULL,
	"level" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "page_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "guest_invite_policy" text DEFAULT 'admins' NOT NULL;--> statement-breakpoint
ALTER TABLE "page_grants" ADD CONSTRAINT "page_grants_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_grants" ADD CONSTRAINT "page_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_grants" ADD CONSTRAINT "page_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_invites" ADD CONSTRAINT "page_invites_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_invites" ADD CONSTRAINT "page_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_grants_user_idx" ON "page_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "page_invites_page_idx" ON "page_invites" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "page_invites_email_idx" ON "page_invites" USING btree ("email");