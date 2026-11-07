ALTER TABLE "users" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_key" text;--> statement-breakpoint
ALTER TABLE "signup_keys" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "signup_keys" ADD CONSTRAINT "signup_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
