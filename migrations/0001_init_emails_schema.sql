-- Migration number: 0001 	 2026-02-27T13:40:50.863Z
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS email_submissions (
  email_id INTEGER NOT NULL,
  user_hash TEXT NOT NULL,
  PRIMARY KEY (email_id, user_hash),
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_submissions_user_hash
  ON email_submissions(user_hash);
