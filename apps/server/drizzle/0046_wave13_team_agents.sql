-- Team agents (docs/adr/1860-*, 1863-*): inbox items handed to one agent connection, and the person's "copies" setting.
ALTER TABLE "notifications" ADD COLUMN "connection" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "person_too" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_notification_settings" ADD COLUMN "agent_handoff_copy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "notifications_connection_idx" ON "notifications" USING btree ("connection") WHERE connection IS NOT NULL;
