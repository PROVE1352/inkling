-- 부하 감사 M2: hot FK/필터 컬럼 인덱스 (재귀 CTE·목록·백링크·멤버십·export 가속)
CREATE INDEX IF NOT EXISTS pages_workspace_deleted_idx ON pages (workspace_id, deleted_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pages_parent_idx ON pages (parent_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pages_created_by_idx ON pages (created_by);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS page_links_target_idx ON page_links (target_page_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS files_workspace_idx ON files (workspace_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS files_page_idx ON files (page_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);
