# Data Storage Guide

## Project purpose

This app does two things:

1. Collects waitlist emails for Loop.
2. Optionally scans a signed-in Cornell user's Gmail metadata to collect unique sender email addresses (not message bodies) for listserv landscape analysis.

## Storage locations

### 1) Cloudflare D1 (primary persistent storage)

- Database binding: `loop_extract_emails_prod`
- Database name: `loop-extract-emails-prod`
- Config file: `wrangler.jsonc`

All server-side persistent data is stored in this D1 database.

### 2) Browser localStorage (client-side job resume state)

- Key: `loop_extract_emails_active_job`
- Value shape: `{ "jobId": string, "jobKey": string }`
- Used only to resume progress polling after refresh/navigation for an active extraction job.

### 3) Cloudflare Queues (transient background job transport)

- Queue binding: `EXTRACTION_QUEUE`
- Queue name: `loop-extraction-jobs`
- Config file: `wrangler.jsonc`
- Stores lightweight `{ jobId, jobKey }` messages so extraction work can continue across worker invocations.

This queue is operational infrastructure, not the source of record. Durable extracted data still lands in D1.

## Cloudflare account context

This project is managed in a shared Cornell DTI Cloudflare account associated with `Dtiincubator@gmail.com`. Create your own Cloudflare account and you can easily be added to this.

## Database tables and schemas

## `waitlist_emails`

Created by migration: `migrations/0002_init_waitlist_table.sql`

Columns:

- `id INTEGER PRIMARY KEY`
- `email TEXT NOT NULL UNIQUE`
- `created_at DATETIME DEFAULT CURRENT_TIMESTAMP`

What it stores:

- Waitlist signup email addresses.
- One row per unique email (duplicates ignored via `INSERT OR IGNORE`).

Write path:

- `src/routes/emails.remote.ts` -> `storeWaitlistEmail`

## `emails`

Created by migration: `migrations/0001_init_emails_schema.sql`

Columns:

- `id INTEGER PRIMARY KEY`
- `email TEXT NOT NULL UNIQUE`

What it stores:

- Canonical unique sender email addresses extracted from Gmail `From` headers.
- Global dedupe table across users.

Write path:

- `src/lib/server/extraction-jobs.ts` -> `storeEmailsForUser`
- SQL: `INSERT OR IGNORE INTO emails (email) VALUES (?)`

## `email_submissions`

Created by migration: `migrations/0001_init_emails_schema.sql`

Columns:

- `email_id INTEGER NOT NULL`
- `user_hash TEXT NOT NULL`
- `PRIMARY KEY (email_id, user_hash)`
- `FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE`

Index:

- `idx_email_submissions_user_hash ON email_submissions(user_hash)`

What it stores:

- Many-to-many link between a unique sender email (`email_id`) and a specific user mailbox hash (`user_hash`).
- This represents "this hashed user has received mail from this sender".

Write path:

- `src/lib/server/extraction-jobs.ts` -> `storeEmailsForUser`
- SQL: `INSERT OR IGNORE INTO email_submissions (email_id, user_hash) SELECT id, ? FROM emails WHERE email = ?`

## `extraction_jobs`

Created by migration: `migrations/0003_init_extraction_jobs_table.sql`

Columns:

- `id TEXT PRIMARY KEY`
- `job_key TEXT`
- `user_email TEXT NOT NULL`
- `user_hash TEXT NOT NULL`
- `access_token TEXT`
- `next_page_token TEXT`
- `status TEXT NOT NULL` (`pending` | `running` | `completed` | `failed`)
- `scanned_messages INTEGER NOT NULL DEFAULT 0`
- `estimated_total_messages INTEGER`
- `unique_senders INTEGER NOT NULL DEFAULT 0`
- `last_error TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Index:

- `extraction_jobs_status_idx ON extraction_jobs(status, updated_at)`

What it stores:

- Progress and control state for background inbox extraction jobs.
- Temporary OAuth access token used while extraction runs.
- Cursor (`next_page_token`) for pagination across Gmail messages.
- User mailbox identity in plaintext (`user_email`) and hashed (`user_hash`).
- Queue-driven chunk progress across repeated worker invocations.

Lifecycle details:

- On job creation: row inserted with `status='pending'`, token set, and estimated Gmail message count if available.
- When a queue consumer starts work: status becomes `running`.
- If more Gmail pages remain after that chunk: status returns to `pending` and the job is re-enqueued.
- On completion: status set to `completed`, `access_token` set to `NULL`.
- On failure: status set to `failed`, `access_token` and `job_key` set to `NULL`, `last_error` populated.

## End-to-end data flow

## A) Waitlist submission flow

1. User enters email on the landing page.
2. Client calls remote command `storeWaitlistEmail`.
3. Server executes `INSERT OR IGNORE` into `waitlist_emails`.

Stored data from this flow:

- Waitlist email address (+ DB timestamp).

## B) Gmail extraction flow

1. User clicks sign-in; Google OAuth returns an access token (`gmail.readonly` scope).
2. Client calls remote command `startEmailExtraction` with that token.
3. Server:
   - Fetches Gmail profile to determine `user_email` and total message estimate.
   - Computes `user_hash = SHA-256(user_email + USER_HASH_SALT)`.
   - Inserts an `extraction_jobs` row with job IDs and token.
   - Enqueues `{ jobId, jobKey }` onto `EXTRACTION_QUEUE`.
4. `worker.js` receives queue batches and calls `handleExtractionQueueBatch`.
5. Each queue invocation calls `processExtractionJobChunk` and processes up to 4 Gmail pages.
6. For each Gmail page:
   - Retrieves message IDs.
   - Batch-fetches message metadata headers (`From` only).
   - Extracts normalized sender emails via regex.
   - Filters out the mailbox owner's own email.
   - Upserts into `emails` and `email_submissions`.
7. If more pages remain, the same `{ jobId, jobKey }` payload is re-enqueued for the next worker invocation.
8. Job status is polled by the client until `completed` or `failed`.
9. On completion/failure, token is cleared server-side.

Stored data from this flow:

- Sender email addresses (unique global set in `emails`).
- Sender-to-user-hash relationships in `email_submissions`.
- Job metadata/progress/errors in `extraction_jobs`.
- Local browser resume token pair (`jobId`, `jobKey`) in localStorage during active jobs.

## Environment variables and secrets

Expected runtime env vars (Cloudflare Worker environment):

- `PUBLIC_GOOGLE_CLIENT_ID`: public OAuth client ID used by frontend sign-in.
- `GOOGLE_CLIENT_SECRET`: present in worker types; not directly referenced in current app code paths.
- `USER_HASH_SALT`: server-side salt used when hashing user emails.

Important runtime bindings:

- `loop_extract_emails_prod`: Cloudflare D1 database binding.
- `EXTRACTION_QUEUE`: Cloudflare Queue binding used to schedule extraction chunks.

Important notes:

- Do not commit real secret values in repository files.
- `USER_HASH_SALT` should remain secret and stable for consistent hashing.

## Privacy notes

- `user_email` is stored in plaintext in `extraction_jobs`.
- OAuth `access_token` is stored temporarily in `extraction_jobs` while processing and cleared on terminal states.
- `jobId` + `jobKey` gate read/process access to job status and processing steps.

## Operational notes

- New environments must apply migrations before first use.
- `extraction_jobs` is created by `migrations/0003_init_extraction_jobs_table.sql`; this branch intentionally does not rely on runtime table creation.
- `worker.js` is the deployed worker entrypoint that combines the SvelteKit app with the queue consumer.
- `wrangler.jsonc` defines the deployed worker, D1 binding, and queue producer/consumer configuration.
- `wrangler.app.jsonc` is used by the Svelte adapter build configuration for the app worker.
- `wrangler.jsonc` currently points to a remote D1 DB, so local development can affect production-linked data unless bindings are changed.
