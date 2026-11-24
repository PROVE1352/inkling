ALTER TABLE "users" ADD COLUMN "trial" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "users_trial_idx" ON "users" USING btree ("expires_at") WHERE "users"."trial";