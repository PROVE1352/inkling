CREATE TABLE "user_onboarding" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_onboarding" ADD CONSTRAINT "user_onboarding_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Accounts that exist before onboarding was introduced are not new: no intro, no checklist unless they ask (docs/adr/2380-*).
INSERT INTO "user_onboarding" ("user_id", "state") SELECT "id", '{"legacy": true}'::jsonb FROM "users" ON CONFLICT DO NOTHING;
