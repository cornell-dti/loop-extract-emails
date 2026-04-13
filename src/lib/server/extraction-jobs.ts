import { error } from '@sveltejs/kit';

const GMAIL_SCOPE_PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const GMAIL_SCOPE_MESSAGES = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
const GMAIL_BATCH_ENDPOINT = 'https://www.googleapis.com/batch/gmail/v1';

const EMAIL_BATCH_SIZE = 50;
const GMAIL_BATCH_API_SIZE = 100;
const MESSAGES_PER_PAGE = 500;
const PAGES_PER_INVOCATION = 4;

const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30_000;

type ExtractionJobStatus = 'pending' | 'running' | 'completed' | 'failed';

type GmailListResponse = {
	messages?: Array<{ id: string }>;
	nextPageToken?: string;
};

type GmailMessageResponse = {
	payload?: {
		headers?: Array<{ name?: string; value?: string }>;
	};
};

type GmailProfileResponse = {
	emailAddress?: string;
	messagesTotal?: number;
};

type ExtractionJobRow = {
	id: string;
	job_key: string | null;
	user_email: string;
	user_hash: string;
	access_token: string | null;
	next_page_token: string | null;
	status: ExtractionJobStatus;
	scanned_messages: number;
	estimated_total_messages: number | null;
	unique_senders: number;
	last_error: string | null;
};

type RetryDecision = {
	retryable: boolean;
	reason: string;
	retryAfterMs?: number;
};

type GoogleErrorPayload = {
	error?: {
		message?: string;
		status?: string;
		errors?: Array<{ reason?: string }>;
	};
};

const RETRYABLE_GMAIL_403_REASONS = new Set([
	'ratelimitexceeded',
	'userratelimitexceeded',
	'quotaexceeded',
	'dailylimitexceeded',
	'backenderror'
]);

export async function ensureExtractionTables(db: D1Database): Promise<void> {
	await db
		.prepare(
			`
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
            )
            `
		)
		.run();

	await db
		.prepare(
			'CREATE INDEX IF NOT EXISTS extraction_jobs_status_idx ON extraction_jobs(status, updated_at)'
		)
		.run();
}

export async function createExtractionJob(params: {
	db: D1Database;
	salt: string;
	accessToken: string;
}): Promise<{ jobId: string; jobKey: string }> {
	const { db, salt, accessToken } = params;

	const profile = await gmailFetch<GmailProfileResponse>(GMAIL_SCOPE_PROFILE, accessToken);
	const ownEmail = profile.emailAddress?.toLowerCase();
	if (!ownEmail) throw error(400, 'Could not determine signed-in Gmail address.');

	const jobId = crypto.randomUUID();
	const jobKey = crypto.randomUUID();
	const userHash = await hashUser(ownEmail, salt);
	const now = new Date().toISOString();

	await db
		.prepare(
			`
            INSERT INTO extraction_jobs (
                id, job_key, user_email, user_hash, access_token, next_page_token, status,
                scanned_messages, estimated_total_messages, unique_senders, last_error,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', 0, ?, 0, NULL, ?, ?)
            `
		)
		.bind(
			jobId,
			jobKey,
			ownEmail,
			userHash,
			accessToken,
			typeof profile.messagesTotal === 'number' && profile.messagesTotal > 0
				? profile.messagesTotal
				: null,
			now,
			now
		)
		.run();

	return { jobId, jobKey };
}

export async function getExtractionStatus(db: D1Database, jobId: string, jobKey: string) {
	const row = await db
		.prepare(
			`
            SELECT
                id,
                job_key,
                status,
                scanned_messages,
                estimated_total_messages,
                unique_senders,
                last_error
            FROM extraction_jobs
            WHERE id = ?
            `
		)
		.bind(jobId)
		.first<{
			id: string;
			job_key: string | null;
			status: ExtractionJobStatus;
			scanned_messages: number;
			estimated_total_messages: number | null;
			unique_senders: number;
			last_error: string | null;
		}>();

	if (!row) throw error(404, 'Extraction job not found.');
	if (row.job_key !== null && row.job_key !== jobKey) throw error(403, 'Invalid job key.');

	return {
		jobId: row.id,
		status: row.status,
		scannedMessages: row.scanned_messages,
		estimatedTotalMessages: row.estimated_total_messages,
		uniqueSenders: row.unique_senders,
		errorMessage: row.last_error
	};
}

export async function processExtractionJobChunk(params: {
	db: D1Database;
	jobId: string;
	jobKey: string;
}): Promise<{ done: boolean }> {
	const { db, jobId, jobKey } = params;

	const job = await db
		.prepare(
			`
            SELECT
                id,
                job_key,
                user_email,
                user_hash,
                access_token,
                next_page_token,
                status,
                scanned_messages,
                estimated_total_messages,
                unique_senders,
                last_error
            FROM extraction_jobs
            WHERE id = ?
            `
		)
		.bind(jobId)
		.first<ExtractionJobRow>();

	if (!job || job.job_key !== jobKey) return { done: true };
	if (job.status === 'completed' || job.status === 'failed') return { done: true };
	if (!job.access_token) {
		await markJobFailed(db, jobId, 'Missing access token for extraction job.');
		return { done: true };
	}

	await db
		.prepare('UPDATE extraction_jobs SET status = ?, updated_at = ? WHERE id = ?')
		.bind('running', new Date().toISOString(), jobId)
		.run();

	let nextPageToken = job.next_page_token ?? undefined;
	let scannedMessages = job.scanned_messages;

	try {
		for (let i = 0; i < PAGES_PER_INVOCATION; i += 1) {
			const listUrl = new URL(GMAIL_SCOPE_MESSAGES);
			listUrl.searchParams.set('maxResults', String(MESSAGES_PER_PAGE));
			listUrl.searchParams.set('includeSpamTrash', 'true');
			if (nextPageToken) listUrl.searchParams.set('pageToken', nextPageToken);

			const page = await gmailFetch<GmailListResponse>(listUrl.toString(), job.access_token);
			const messageIds = page.messages?.map((message) => message.id) ?? [];

			if (messageIds.length > 0) {
				const fromHeaders = await batchGetFromHeaders(messageIds, job.access_token);
				const senders = extractUniqueSenders(fromHeaders, job.user_email);
				if (senders.length > 0) {
					await storeEmailsForUser({ db, userHash: job.user_hash, emails: senders });
				}
			}

			scannedMessages += messageIds.length;
			nextPageToken = page.nextPageToken;

			if (!nextPageToken) break;
		}

		const uniqueSenders = await getUniqueSenderCount(db, job.user_hash);
		const done = !nextPageToken;

		await db
			.prepare(
				`
                    UPDATE extraction_jobs
                    SET
                        status = ?,
                        scanned_messages = ?,
                        unique_senders = ?,
                        next_page_token = ?,
                        access_token = ?,
                        last_error = NULL,
                        updated_at = ?
                    WHERE id = ?
                    `
			)
			.bind(
				done ? 'completed' : 'pending',
				scannedMessages,
				uniqueSenders,
				nextPageToken ?? null,
				done ? null : job.access_token,
				new Date().toISOString(),
				jobId
			)
			.run();

		return { done };
	} catch (err) {
		await markJobFailed(db, jobId, formatUserFacingError(err));
		return { done: true };
	}
}

async function markJobFailed(db: D1Database, jobId: string, message: string): Promise<void> {
	await db
		.prepare(
			`
            UPDATE extraction_jobs
            SET
                status = 'failed',
                last_error = ?,
                access_token = NULL,
                job_key = NULL,
                updated_at = ?
            WHERE id = ?
            `
		)
		.bind(message, new Date().toISOString(), jobId)
		.run();
}

async function hashUser(user: string, salt: string) {
	const data = new TextEncoder().encode(user + salt);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getUniqueSenderCount(db: D1Database, userHash: string): Promise<number> {
	const row = await db
		.prepare('SELECT COUNT(*) as count FROM email_submissions WHERE user_hash = ?')
		.bind(userHash)
		.first<{ count: number | string | null }>();

	return Number(row?.count ?? 0);
}

async function storeEmailsForUser(params: {
	db: D1Database;
	userHash: string;
	emails: string[];
}): Promise<void> {
	const { db, userHash, emails } = params;

	for (let i = 0; i < emails.length; i += EMAIL_BATCH_SIZE) {
		const batchEmails = emails.slice(i, i + EMAIL_BATCH_SIZE);
		const statements = batchEmails.flatMap((email) => [
			db.prepare('INSERT OR IGNORE INTO emails (email) VALUES (?)').bind(email),
			db
				.prepare(
					'INSERT OR IGNORE INTO email_submissions (email_id, user_hash) SELECT id, ? FROM emails WHERE email = ?'
				)
				.bind(userHash, email)
		]);

		if (statements.length > 0) {
			await db.batch(statements);
		}
	}
}

function extractUniqueSenders(headers: string[], ownEmail: string): string[] {
	const own = ownEmail.toLowerCase();
	const unique = new Set<string>();

	for (const header of headers) {
		for (const email of extractEmails(header)) {
			if (email !== own) unique.add(email);
		}
	}

	return [...unique];
}

async function batchGetFromHeaders(messageIds: string[], accessToken: string): Promise<string[]> {
	const allHeaders: string[] = [];

	for (const requestBatch of chunk(messageIds, GMAIL_BATCH_API_SIZE)) {
		const boundary = `batch_${crypto.randomUUID()}`;
		const body =
			requestBatch
				.map(
					(id) =>
						`--${boundary}\r\nContent-Type: application/http\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From HTTP/1.1\r\n\r\n`
				)
				.join('') + `--${boundary}--`;

		const response = await fetchWithRetry(GMAIL_BATCH_ENDPOINT, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': `multipart/mixed; boundary=${boundary}`
			},
			body
		});

		allHeaders.push(...parseBatchResponse(await response.text()));
	}

	return allHeaders;
}

async function gmailFetch<T>(url: string, accessToken: string): Promise<T> {
	const response = await fetchWithRetry(url, {
		headers: {
			Authorization: `Bearer ${accessToken}`
		}
	});

	return (await response.json()) as T;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
	let attempt = 0;

	while (true) {
		try {
			const response = await fetch(url, init);

			if (response.ok) return response;

			const body = await response.text();
			const decision = getGmailRetryDecision(response, body);
			if (!decision.retryable) {
				throw new Error(`Gmail API error ${response.status}: ${body}`);
			}

			const delay = computeRetryDelay(attempt, decision.retryAfterMs);
			attempt += 1;
			await sleep(delay);
		} catch (err) {
			if (err instanceof Error && err.message.startsWith('Gmail API error ')) {
				throw err;
			}

			const decision = getNetworkRetryDecision(err);
			if (!decision.retryable) throw err;

			const delay = computeRetryDelay(attempt);
			attempt += 1;
			await sleep(delay);
		}
	}
}

function parseBatchResponse(responseText: string): string[] {
	const results: string[] = [];
	const parts = responseText.split(/--batch_\S+/);

	for (const part of parts) {
		const jsonStart = part.indexOf('{');
		const jsonEnd = part.lastIndexOf('}');
		if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) continue;

		try {
			const msg = JSON.parse(part.slice(jsonStart, jsonEnd + 1)) as GmailMessageResponse;
			const from = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === 'from');
			results.push(from?.value ?? '');
		} catch {
			continue;
		}
	}

	return results;
}

function extractEmails(headerValue: string): string[] {
	const matches = headerValue.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
	if (!matches) return [];
	return matches.map((email) => email.toLowerCase());
}

function getGmailRetryDecision(response: Response, body: string): RetryDecision {
	const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

	if (response.status === 429) {
		return { retryable: true, reason: 'Gmail is rate limiting requests', retryAfterMs };
	}

	if (response.status === 403 && isGmailRateLimitError(body)) {
		return { retryable: true, reason: 'Gmail quota is temporarily exhausted', retryAfterMs };
	}

	if (response.status === 408 || response.status === 425 || response.status >= 500) {
		return { retryable: true, reason: `Gmail returned ${response.status}`, retryAfterMs };
	}

	return { retryable: false, reason: 'Non-retryable Gmail error' };
}

function getNetworkRetryDecision(errorValue: unknown): RetryDecision {
	if (errorValue instanceof DOMException && errorValue.name === 'AbortError') {
		return { retryable: false, reason: 'Request was aborted' };
	}

	const message = getErrorMessage(errorValue).toLowerCase();
	const isNetworkLikeError =
		errorValue instanceof TypeError ||
		/failed to fetch|networkerror|network error|request failed|connection reset|timed out|timeout/.test(
			message
		);

	if (isNetworkLikeError) {
		return { retryable: true, reason: 'Network issue while contacting Gmail' };
	}

	return { retryable: false, reason: 'Non-retryable network error' };
}

function isGmailRateLimitError(body: string): boolean {
	const lowered = body.toLowerCase();
	if (/rate\s*limit|quota|too many requests|daily limit|user rate limit/.test(lowered)) return true;

	const payload = parseGoogleErrorPayload(body);
	if (!payload?.error) return false;

	const reasons = payload.error.errors?.map((entry) => entry.reason?.toLowerCase() ?? '') ?? [];
	if (reasons.some((reason) => RETRYABLE_GMAIL_403_REASONS.has(reason))) return true;

	const statusCode = payload.error.status?.toLowerCase() ?? '';
	if (statusCode.includes('resource_exhausted')) return true;

	const message = payload.error.message?.toLowerCase() ?? '';
	return /rate\s*limit|quota|too many requests|daily limit/.test(message);
}

function parseGoogleErrorPayload(body: string): GoogleErrorPayload | null {
	try {
		return JSON.parse(body) as GoogleErrorPayload;
	} catch {
		return null;
	}
}

function parseRetryAfter(headerValue: string | null): number | undefined {
	if (!headerValue) return undefined;

	const seconds = Number.parseFloat(headerValue);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

	const dateMs = Date.parse(headerValue);
	if (Number.isNaN(dateMs)) return undefined;

	return Math.max(0, dateMs - Date.now());
}

function computeRetryDelay(attempt: number, retryAfterMs?: number): number {
	const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt, 7), RETRY_MAX_DELAY_MS);
	const computedDelay = Math.round(backoff + Math.random() * 750);

	if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
		return Math.max(computedDelay, Math.round(retryAfterMs));
	}

	return computedDelay;
}

function getErrorMessage(errorValue: unknown): string {
	if (typeof errorValue === 'string') return errorValue;
	if (errorValue instanceof Error && typeof errorValue.message === 'string')
		return errorValue.message;

	if (typeof errorValue === 'object' && errorValue !== null) {
		const text = (errorValue as { text?: unknown }).text;
		if (typeof text === 'string' && text.trim()) return text;

		const message = (errorValue as { message?: unknown }).message;
		if (typeof message === 'string' && message.trim()) return message;

		try {
			return JSON.stringify(errorValue);
		} catch {
			return 'Unknown error';
		}
	}

	return 'Unknown error';
}

function formatUserFacingError(errorValue: unknown): string {
	const message = getErrorMessage(errorValue).trim();
	if (!message) return 'Unexpected error. Please try again.';

	const normalized = message.replace(/\s+/g, ' ');
	return normalized.length <= 220 ? normalized : `${normalized.slice(0, 217)}...`;
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
