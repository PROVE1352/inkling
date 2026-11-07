-- 전문 검색 가속: pg_trgm(트라이그램) — ILIKE '%q%' 부분일치에 GIN 인덱스 적용
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS page_texts_text_trgm_idx ON page_texts USING gin (text gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pages_title_trgm_idx ON pages USING gin (title gin_trgm_ops);
