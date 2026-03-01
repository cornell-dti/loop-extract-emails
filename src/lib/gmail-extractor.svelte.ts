import { env } from '$env/dynamic/public';

// ── Types ─────────────────────────────────────────────────────────────────────

type TokenResponse = {
	access_token?: string;
	error?: string;
	error_description?: string;
};

type TokenClient = {
	requestAccessToken: (options?: { prompt?: string }) => void;
};

type GoogleNamespace = {
	accounts: {
		oauth2: {
			initTokenClient: (config: {
				client_id: string;
				scope: string;
				callback: (response: TokenResponse) => void;
			}) => TokenClient;
		};
	};
};

type GmailListResponse = {
	messages?: Array<{ id: string }>;
	nextPageToken?: string;
	resultSizeEstimate?: number;
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

type StoreEmailsPayload = {
	user: string;
	emails: string[];
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

type StoreEmailsFn = (payload: StoreEmailsPayload) => Promise<unknown>;

// ── Constants ─────────────────────────────────────────────────────────────────

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';

const BATCH_SIZE = 500;
const GMAIL_BATCH_API_SIZE = 100;
const BATCH_DELAY_MS = 600;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 120_000;
const RETRYABLE_GMAIL_403_REASONS = new Set([
	'ratelimitexceeded',
	'userratelimitexceeded',
	'quotaexceeded',
	'dailylimitexceeded',
	'backenderror'
]);

// ── Extractor class ───────────────────────────────────────────────────────────

export class GmailExtractor {
	readonly #storeEmails: StoreEmailsFn;
	readonly #googleClientId = env.PUBLIC_GOOGLE_CLIENT_ID;
	#tokenClient: TokenClient | null = null;

	status = $state('Loading Google sign-in...');
	isWorking = $state(false);
	scannedMessages = $state(0);
	estimatedTotalMessages = $state<number | null>(null);

	isDisabled = $derived(!this.#googleClientId || this.isWorking);

	progressPercent = $derived.by((): number | null => {
		if (!this.estimatedTotalMessages || this.estimatedTotalMessages <= 0) return null;
		const percent = (this.scannedMessages / this.estimatedTotalMessages) * 100;
		if (this.isWorking && percent >= 100) return 99;
		return Math.min(100, Math.max(0, Math.round(percent)));
	});

	progressValue = $derived.by((): number | undefined => {
		if (!this.estimatedTotalMessages || this.estimatedTotalMessages <= 0) return undefined;
		if (this.isWorking && this.scannedMessages >= this.estimatedTotalMessages) {
			return this.estimatedTotalMessages * 0.99;
		}
		return Math.min(this.scannedMessages, this.estimatedTotalMessages);
	});

	constructor(storeEmails: StoreEmailsFn) {
		this.#storeEmails = storeEmails;
	}

	/** Call from onMount. Returns a cleanup function. */
	init(): () => void {
		if (!this.#googleClientId) {
			this.status = 'Missing PUBLIC_GOOGLE_CLIENT_ID. Add it to your environment and reload.';
			return () => {};
		}

		let cancelled = false;

		void (async () => {
			try {
				await loadGoogleIdentityScript();
				if (cancelled) return;

				const oauth2 = getGoogleNamespace()?.accounts?.oauth2;
				if (!oauth2) throw new Error('Google OAuth client failed to initialize.');

				this.#tokenClient = oauth2.initTokenClient({
					client_id: this.#googleClientId!,
					scope: GOOGLE_SCOPE,
					callback: (response) => {
						void this.#handleTokenResponse(response);
					}
				});

				this.status = 'Ready. Click "Sign in with Google".';
			} catch (error) {
				console.error(error);
				this.status = 'Unable to load Google sign-in.';
			}
		})();

		return () => {
			cancelled = true;
		};
	}

	async signIn(): Promise<void> {
		if (this.isWorking) return;

		if (!this.#tokenClient) {
			this.status = 'Google sign-in is still loading.';
			return;
		}

		this.status = 'Waiting for Google authorization...';
		this.#tokenClient.requestAccessToken({ prompt: 'consent' });
	}

	async #handleTokenResponse(response: TokenResponse): Promise<void> {
		if (response.error) {
			this.status = `Google sign-in failed: ${response.error_description ?? response.error}`;
			return;
		}

		const accessToken = response.access_token;
		if (!accessToken) {
			this.status = 'Google sign-in returned no access token.';
			return;
		}

		this.scannedMessages = 0;
		this.estimatedTotalMessages = null;
		this.isWorking = true;
		this.status = 'Reading mailbox history. This can take a while for large inboxes...';

		try {
			const { ownEmail, uniqueSenders } = await this.#collectAndUpload(accessToken);
			console.log('Your email:', ownEmail);
			this.status = `Done. Thank you!\nFound and uploaded ${uniqueSenders.toLocaleString()} unique senders.`;
		} catch (error) {
			console.error(error);
			this.status = `Stopped due to a non-retryable error:\n${formatUserFacingError(error)}`;
		} finally {
			this.isWorking = false;
		}
	}

	async #collectAndUpload(
		accessToken: string
	): Promise<{ ownEmail: string; uniqueSenders: number }> {
		const profile = await this.#gmailFetch<GmailProfileResponse>(
			'https://gmail.googleapis.com/gmail/v1/users/me/profile',
			accessToken
		);
		const ownEmail = profile.emailAddress?.toLowerCase();
		if (!ownEmail) throw new Error('Could not determine signed-in Gmail address.');

		this.estimatedTotalMessages =
			typeof profile.messagesTotal === 'number' && profile.messagesTotal > 0
				? profile.messagesTotal
				: null;

		const unique = new Set<string>();
		let nextPageToken: string | undefined;
		let processed = 0;

		do {
			const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
			listUrl.searchParams.set('maxResults', '500');
			listUrl.searchParams.set('includeSpamTrash', 'true');
			if (nextPageToken) listUrl.searchParams.set('pageToken', nextPageToken);

			const page = await this.#gmailFetch<GmailListResponse>(listUrl.toString(), accessToken);
			const messageIds = page.messages?.map((m) => m.id) ?? [];

			for (const batch of chunk(messageIds, BATCH_SIZE)) {
				const fromHeaders = await this.#batchGetFromHeaders(batch, accessToken);
				const newSenders: string[] = [];

				for (const header of fromHeaders) {
					for (const email of extractEmails(header)) {
						if (email !== ownEmail && !unique.has(email)) {
							unique.add(email);
							newSenders.push(email);
						}
					}
				}

				if (newSenders.length > 0) {
					for (const senderBatch of chunk(newSenders, BATCH_SIZE)) {
						await this.#storeEmailsWithRetry({ user: ownEmail, emails: senderBatch });
					}
				}

				processed += batch.length;
				this.scannedMessages = processed;
				if (this.estimatedTotalMessages !== null && this.scannedMessages > this.estimatedTotalMessages) {
					this.estimatedTotalMessages = this.scannedMessages;
				}

				const progressText = this.estimatedTotalMessages
					? ` of ~${this.estimatedTotalMessages.toLocaleString()}`
					: '';
				this.status = `Scanned ${processed.toLocaleString()}${progressText} messages.\nFound ${unique.size.toLocaleString()} unique senders.`;

				if (batch.length === BATCH_SIZE) await sleep(BATCH_DELAY_MS);
			}

			nextPageToken = page.nextPageToken;
		} while (nextPageToken);

		return { ownEmail, uniqueSenders: unique.size };
	}

	async #batchGetFromHeaders(messageIds: string[], accessToken: string): Promise<string[]> {
		const allHeaders: string[] = [];

		for (const requestBatch of chunk(messageIds, GMAIL_BATCH_API_SIZE)) {
			const boundary = `batch_${crypto.randomUUID()}`;
			const parts = requestBatch.map(
				(id) =>
					`--${boundary}\r\nContent-Type: application/http\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From HTTP/1.1\r\n\r\n`
			);

			const body = parts.join('') + `--${boundary}--`;

			const response = await this.#fetchWithRetry('https://www.googleapis.com/batch/gmail/v1', {
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

	async #gmailFetch<T>(url: string, accessToken: string): Promise<T> {
		const response = await this.#fetchWithRetry(url, {
			headers: { Authorization: `Bearer ${accessToken}` }
		});
		return (await response.json()) as T;
	}

	async #fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
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
				this.status = `${decision.reason}. Waiting ${formatDelay(delay)} before retry ${attempt.toLocaleString()}...`;
				await sleep(delay);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith('Gmail API error ')) throw error;

				const decision = getNetworkRetryDecision(error);

				if (!decision.retryable) throw error;

				const delay = computeRetryDelay(attempt);
				attempt += 1;
				this.status = `${decision.reason}. Waiting ${formatDelay(delay)} before retry ${attempt.toLocaleString()}...`;
				await sleep(delay);
			}
		}
	}

	async #storeEmailsWithRetry(payload: StoreEmailsPayload): Promise<void> {
		let attempt = 0;

		while (true) {
			try {
				await this.#storeEmails(payload);
				return;
			} catch (error) {
				const decision = getUploadRetryDecision(error);

				if (!decision.retryable) throw error;

				const delay = computeRetryDelay(attempt, decision.retryAfterMs);
				attempt += 1;
				this.status = `${decision.reason}. Waiting ${formatDelay(delay)} before retry ${attempt.toLocaleString()}...`;
				await sleep(delay);
			}
		}
	}
}

// ── Pure utility functions ────────────────────────────────────────────────────

function loadGoogleIdentityScript(): Promise<void> {
	if (getGoogleNamespace()?.accounts?.oauth2) return Promise.resolve();

	const existing = document.querySelector<HTMLScriptElement>(
		`script[src="${GOOGLE_IDENTITY_SCRIPT}"]`
	);
	if (existing) return waitForGoogleIdentity();

	return new Promise<void>((resolve, reject) => {
		const script = document.createElement('script');
		script.src = GOOGLE_IDENTITY_SCRIPT;
		script.async = true;
		script.defer = true;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error('Failed to load Google identity script.'));
		const head = document.head as unknown as { appendChild: (node: Node) => Node } | null;
		if (!head) {
			reject(new Error('Document head not available.'));
			return;
		}
		head.appendChild(script);
	}).then(waitForGoogleIdentity);
}

function waitForGoogleIdentity(): Promise<void> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timer = window.setInterval(() => {
			if (getGoogleNamespace()?.accounts?.oauth2) {
				window.clearInterval(timer);
				resolve();
				return;
			}
			if (Date.now() - startedAt > 5000) {
				window.clearInterval(timer);
				reject(new Error('Timed out waiting for Google identity client.'));
			}
		}, 50);
	});
}

function getGoogleNamespace(): GoogleNamespace | undefined {
	return (window as Window & { google?: GoogleNamespace }).google;
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
			// Skip unparseable parts
		}
	}

	return results;
}

function extractEmails(headerValue: string): string[] {
	const matches = headerValue.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
	if (!matches) return [];
	return matches.map((e) => e.toLowerCase());
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

function getNetworkRetryDecision(error: unknown): RetryDecision {
	if (error instanceof DOMException && error.name === 'AbortError') {
		return { retryable: false, reason: 'Request was aborted' };
	}

	const message = getErrorMessage(error).toLowerCase();
	const isNetworkLikeError =
		error instanceof TypeError ||
		/failed to fetch|networkerror|network error|request failed|connection reset|timed out|timeout/.test(
			message
		);

	if (isNetworkLikeError) {
		return { retryable: true, reason: 'Network issue while contacting Gmail' };
	}

	return { retryable: false, reason: 'Non-retryable network error' };
}

function getUploadRetryDecision(error: unknown): RetryDecision {
	const statusCode = getErrorStatusCode(error);
	const message = getErrorMessage(error).toLowerCase();

	if (
		statusCode === 408 ||
		statusCode === 425 ||
		statusCode === 429 ||
		(statusCode !== null && statusCode >= 500)
	) {
		return { retryable: true, reason: 'Upload endpoint is temporarily unavailable' };
	}

	if (statusCode === 403 && /rate|quota|limit/.test(message)) {
		return { retryable: true, reason: 'Upload endpoint is temporarily throttled' };
	}

	if (
		/too many requests|rate limit|temporarily unavailable|database is locked|database is busy|timed out|timeout|failed to fetch|network error|networkerror|connection reset|overloaded|try again/.test(
			message
		)
	) {
		return { retryable: true, reason: 'Upload temporarily failed' };
	}

	return { retryable: false, reason: 'Non-retryable upload error' };
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
	const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt, 8), RETRY_MAX_DELAY_MS);
	const computedDelay = Math.round(backoff + Math.random() * 1000);

	if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
		return Math.max(computedDelay, Math.round(retryAfterMs));
	}

	return computedDelay;
}

function formatDelay(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;

	if (minutes === 0) return `${totalSeconds}s`;
	if (seconds === 0) return `${minutes}m`;
	return `${minutes}m ${seconds}s`;
}

function getErrorStatusCode(error: unknown): number | null {
	if (typeof error === 'object' && error !== null) {
		const status = (error as { status?: unknown }).status;
		if (typeof status === 'number' && Number.isFinite(status)) return status;
	}

	const message = getErrorMessage(error);
	const explicitMatch =
		message.match(/status(?: code)?\s*(\d{3})/i) ?? message.match(/error\s*(\d{3})/i);
	if (explicitMatch) return Number.parseInt(explicitMatch[1], 10);

	const knownMatch = message.match(/\b(403|408|425|429|500|502|503|504)\b/);
	if (knownMatch) return Number.parseInt(knownMatch[1], 10);

	return null;
}

function getErrorMessage(error: unknown): string {
	if (typeof error === 'string') return error;

	if (error instanceof Error && typeof error.message === 'string') return error.message;

	if (typeof error === 'object' && error !== null) {
		const text = (error as { text?: unknown }).text;
		if (typeof text === 'string' && text.trim()) return text;

		const message = (error as { message?: unknown }).message;
		if (typeof message === 'string' && message.trim()) return message;

		try {
			return JSON.stringify(error);
		} catch {
			return 'Unknown error';
		}
	}

	return 'Unknown error';
}

function formatUserFacingError(error: unknown): string {
	const message = getErrorMessage(error).trim();
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
