ALTER TABLE "collections" ADD COLUMN "row_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "row_number" integer;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "edited_by" uuid;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "edited_via" text;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pages_row_number_uq" ON "pages" USING btree ("parent_id","row_number") WHERE "pages"."row_number" IS NOT NULL;--> statement-breakpoint
-- Unique ID numbers of collection rows (docs/adr/2140-*). Hand-written: drizzle-kit does not model
-- functions or triggers. Every way a page enters a collection (row create, duplicate, import, sheet
-- sync, templates, forms, a move) passes this trigger, so the number is handed out in one place: the
-- UPDATE takes the collection row's lock until commit, so parallel creates get distinct numbers, and
-- the counter only grows, so a number of a deleted row is never handed out again. A row that leaves
-- the collection loses its number; one that enters another collection gets that collection's next one.
CREATE OR REPLACE FUNCTION inkling_row_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  NEW.row_number := NULL;
  IF NEW.parent_id IS NOT NULL THEN
    UPDATE collections SET row_seq = row_seq + 1
     WHERE page_id = NEW.parent_id AND fields @> '[{"type":"uniqueId"}]'::jsonb
    RETURNING row_seq INTO n;
    NEW.row_number := n;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER pages_row_number_ins BEFORE INSERT ON pages FOR EACH ROW EXECUTE FUNCTION inkling_row_number();--> statement-breakpoint
CREATE TRIGGER pages_row_number_move BEFORE UPDATE OF parent_id ON pages FOR EACH ROW WHEN (NEW.parent_id IS DISTINCT FROM OLD.parent_id) EXECUTE FUNCTION inkling_row_number();
--> statement-breakpoint
-- A collection that gets an ID property (created with one, as templates, imports and duplicates do
-- after inserting the rows, or given one by a fields update) numbers its rows that have none, in the
-- collection's manual order, from its counter. Trashed rows are numbered too, so a restore keeps one.
CREATE OR REPLACE FUNCTION inkling_row_number_backfill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  WITH todo AS (
    SELECT id, row_number() OVER (ORDER BY sort_order, created_at, id) AS rn
      FROM pages WHERE parent_id = NEW.page_id AND row_number IS NULL
  ), upd AS (
    UPDATE pages p SET row_number = NEW.row_seq + todo.rn FROM todo WHERE p.id = todo.id RETURNING 1
  )
  SELECT count(*) INTO n FROM upd;
  NEW.row_seq := NEW.row_seq + n;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER collections_row_number_backfill BEFORE INSERT OR UPDATE OF fields ON collections FOR EACH ROW WHEN (NEW.fields @> '[{"type":"uniqueId"}]'::jsonb) EXECUTE FUNCTION inkling_row_number_backfill();
