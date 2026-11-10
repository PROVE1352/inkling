-- Row numbers (docs/adr/2140-*, 2320-*): the n-th bump of one collection's counter in a transaction no longer walks
-- the n-1 row versions that transaction left behind. Hand-written: only the function of 0051 changes (no
-- table, column, index or trigger change). The transaction-local note '<parent>@<ctid>' (set_config(...,
-- true), reset at commit/rollback and at a savepoint rollback) points at this transaction's newest version
-- of that collection row; the UPDATE goes there by ctid. Same UPDATE, same WHERE (page_id and the ID test
-- stay, so a stale or foreign note matches nothing and falls back to the 0051 lookup), same row lock.
CREATE OR REPLACE FUNCTION inkling_row_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer; t tid; c text;
BEGIN
  NEW.row_number := NULL;
  IF NEW.parent_id IS NOT NULL THEN
    c := current_setting('inkling.row_seq_at', true);
    IF c LIKE NEW.parent_id::text || '@%' THEN
      UPDATE collections SET row_seq = row_seq + 1
       WHERE ctid = substr(c, 38)::tid AND page_id = NEW.parent_id
         AND fields @> '[{"type":"uniqueId"}]'::jsonb
      RETURNING row_seq, ctid INTO n, t;
    END IF;
    IF n IS NULL THEN
      UPDATE collections SET row_seq = row_seq + 1
       WHERE page_id = NEW.parent_id AND fields @> '[{"type":"uniqueId"}]'::jsonb
      RETURNING row_seq, ctid INTO n, t;
    END IF;
    IF n IS NOT NULL THEN
      PERFORM set_config('inkling.row_seq_at', NEW.parent_id::text || '@' || t::text, true);
    END IF;
    NEW.row_number := n;
  END IF;
  RETURN NEW;
END $$;
