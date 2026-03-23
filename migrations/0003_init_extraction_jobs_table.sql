-- Migration number: 0003 	 2026-03-22T00:00:00.000Z
CREATE TABLE IF NOT EXISTS extraction_jobs (
  id TEXT PRIMARY KEY,
  job_key TEXT,
  user_email TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  access_token TEXT,
  next_page_token TEXT,
  status TEXT NOT NULL,
  scanned_messages INTEGER NOT NULL DEFAULT 0,
  estimated_total_messages INTEGER,
  unique_senders INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS extraction_jobs_status_idx
  ON extraction_jobs(status, updated_at);
