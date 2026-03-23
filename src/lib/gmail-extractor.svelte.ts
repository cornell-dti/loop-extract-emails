import { PUBLIC_GOOGLE_CLIENT_ID } from '$env/static/public';

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
				hosted_domain?: string;
				callback: (response: TokenResponse) => void;
			}) => TokenClient;
		};
	};
};

type StartEmailExtractionFn = (payload: {
	accessToken: string;
}) => Promise<{ jobId: string; jobKey: string }>;

type GetEmailExtractionStatusFn = (payload: { jobId: string; jobKey: string }) => Promise<{
	jobId: string;
	status: 'pending' | 'running' | 'completed' | 'failed';
	scannedMessages: number;
	estimatedTotalMessages: number | null;
	uniqueSenders: number;
	errorMessage: string | null;
}>;

type PersistedJob = { jobId: string; jobKey: string };

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
const GOOGLE_HOSTED_DOMAIN = 'cornell.edu';

const STATUS_POLL_INTERVAL_MS = 1500;
const ACTIVE_JOB_STORAGE_KEY = 'loop_extract_emails_active_job';
const MAX_STATUS_ERRORS_BEFORE_RESET = 6;

export class GmailExtractor {
	readonly #startEmailExtraction: StartEmailExtractionFn;
	readonly #getEmailExtractionStatus: GetEmailExtractionStatusFn;
	readonly #googleClientId = PUBLIC_GOOGLE_CLIENT_ID;
	#tokenClient: TokenClient | null = null;
	#statusPollTimer: number | null = null;
	#activeJobId: string | null = null;
	#activeJobKey: string | null = null;
	#statusErrorCount = 0;

	status = $state('Loading Google sign-in...');
	isWorking = $state(false);
	completed = $state(false);
	hasError = $state(false);
	scannedMessages = $state(0);
	estimatedTotalMessages = $state<number | null>(null);

	isDisabled = $derived(!this.#googleClientId || this.isWorking);

	progressPercent = $derived.by((): number | null => {
		if (!this.estimatedTotalMessages || this.estimatedTotalMessages <= 0) return null;
		if (this.scannedMessages <= 0) return null;
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

	constructor(
		startEmailExtraction: StartEmailExtractionFn,
		getEmailExtractionStatus: GetEmailExtractionStatusFn
	) {
		this.#startEmailExtraction = startEmailExtraction;
		this.#getEmailExtractionStatus = getEmailExtractionStatus;
	}

	init(): () => void {
		if (!this.#googleClientId) {
			this.status = 'Missing PUBLIC_GOOGLE_CLIENT_ID. Add it to your environment and reload.';
			return () => {};
		}

		let cancelled = false;

		// Reconnect synchronously so the page can show the progress screen immediately
		// without waiting for the Google Identity script (only needed for new sign-ins).
		const persisted = this.#getPersistedActiveJob();
		if (persisted) {
			this.#activeJobId = persisted.jobId;
			this.#activeJobKey = persisted.jobKey;
			this.isWorking = true;
			this.status = 'Reconnecting to active mailbox scan...';
			this.#startPolling();
			void this.#pollJobStatus().catch(() => {});
		}

		void (async () => {
			try {
				await loadGoogleIdentityScript();
				if (cancelled) return;

				const oauth2 = getGoogleNamespace()?.accounts?.oauth2;
				if (!oauth2) throw new Error('Google OAuth client failed to initialize.');

				this.#tokenClient = oauth2.initTokenClient({
					client_id: this.#googleClientId,
					scope: GOOGLE_SCOPE,
					hosted_domain: GOOGLE_HOSTED_DOMAIN,
					callback: (response) => {
						void this.#handleTokenResponse(response);
					}
				});

				if (!this.#activeJobId) {
					this.status = 'Ready. Click "Sign in with Google".';
				}
			} catch {
				if (!this.#activeJobId) {
					this.status = 'Unable to load Google sign-in.';
				}
			}
		})();

		return () => {
			cancelled = true;
			this.#stopPolling();
		};
	}

	async signIn(): Promise<void> {
		if (this.isWorking) return;
		this.completed = false;
		this.hasError = false;

		if (!this.#tokenClient) {
			this.hasError = true;
			this.status = 'Google sign-in is still loading.';
			return;
		}

		this.status = 'Waiting for Google authorization...';
		this.#tokenClient.requestAccessToken({ prompt: 'consent' });
	}

	reset(): void {
		this.#stopPolling();
		this.#clearActiveJob();
		this.#statusErrorCount = 0;
		this.isWorking = false;
		this.completed = false;
		this.hasError = false;
		this.scannedMessages = 0;
		this.estimatedTotalMessages = null;

		if (!this.#googleClientId) {
			this.status = 'Missing PUBLIC_GOOGLE_CLIENT_ID. Add it to your environment and reload.';
			return;
		}

		this.status = this.#tokenClient
			? 'Ready. Click "Sign in with Google".'
			: 'Loading Google sign-in...';
	}

	async #handleTokenResponse(response: TokenResponse): Promise<void> {
		if (response.error) {
			this.hasError = true;
			this.status = `Google sign-in failed: ${response.error_description ?? response.error}`;
			return;
		}

		const accessToken = response.access_token;
		if (!accessToken) {
			this.hasError = true;
			this.status = 'Google sign-in returned no access token.';
			return;
		}

		this.#stopPolling();
		this.#clearActiveJob();
		this.#statusErrorCount = 0;
		this.scannedMessages = 0;
		this.estimatedTotalMessages = null;
		this.isWorking = true;
		this.completed = false;
		this.hasError = false;
		this.status = 'Starting secure server-side extraction job...';

		try {
			const { jobId, jobKey } = await this.#startEmailExtraction({ accessToken });
			this.#setActiveJob(jobId, jobKey);
			this.status = 'Mailbox scan started. You can leave this tab open or close it.';
			await this.#pollJobStatus();
			this.#startPolling();
		} catch (error) {
			this.#clearActiveJob();
			this.isWorking = false;
			this.hasError = true;
			this.status = `Could not start extraction: ${formatUserFacingError(error)}`;
		}
	}

	#startPolling(): void {
		this.#stopPolling();
		this.#statusPollTimer = window.setInterval(() => {
			void this.#pollJobStatus().catch(() => {});
		}, STATUS_POLL_INTERVAL_MS);
	}

	#getPersistedActiveJob(): PersistedJob | null {
		try {
			const raw = window.localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as unknown;
			if (
				typeof parsed === 'object' &&
				parsed !== null &&
				typeof (parsed as Record<string, unknown>).jobId === 'string' &&
				typeof (parsed as Record<string, unknown>).jobKey === 'string'
			) {
				return parsed as PersistedJob;
			}
			return null;
		} catch {
			return null;
		}
	}

	#setActiveJob(jobId: string, jobKey: string): void {
		this.#activeJobId = jobId;
		this.#activeJobKey = jobKey;
		try {
			window.localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, JSON.stringify({ jobId, jobKey }));
		} catch {
			return;
		}
	}

	#clearActiveJob(): void {
		this.#activeJobId = null;
		this.#activeJobKey = null;
		try {
			window.localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
		} catch {
			return;
		}
	}

	#stopPolling(): void {
		if (this.#statusPollTimer === null) return;
		window.clearInterval(this.#statusPollTimer);
		this.#statusPollTimer = null;
	}

	async #pollJobStatus(): Promise<void> {
		if (!this.#activeJobId || !this.#activeJobKey) return;

		let result: Awaited<ReturnType<GetEmailExtractionStatusFn>>;
		try {
			result = await this.#getEmailExtractionStatus({
				jobId: this.#activeJobId,
				jobKey: this.#activeJobKey
			});
			this.#statusErrorCount = 0;
		} catch (error) {
			this.#statusErrorCount += 1;
			const statusCode = getErrorStatusCode(error);
			const isPermanentError =
				statusCode === 404 ||
				statusCode === 403 ||
				this.#statusErrorCount >= MAX_STATUS_ERRORS_BEFORE_RESET;
			if (isPermanentError) {
				this.#stopPolling();
				this.#clearActiveJob();
				this.#statusErrorCount = 0;
				this.isWorking = false;
				this.completed = false;
				this.hasError = false;
				this.status = 'Ready. Click "Sign in with Google".';
			}
			throw error;
		}

		this.scannedMessages = result.scannedMessages;
		this.estimatedTotalMessages = result.estimatedTotalMessages;

		if (result.status === 'completed') {
			this.isWorking = false;
			this.completed = true;
			this.hasError = false;
			this.status = `Done. Thank you!\nFound and uploaded ${result.uniqueSenders.toLocaleString()} unique senders.`;
			this.#stopPolling();
			this.#clearActiveJob();
			return;
		}

		if (result.status === 'failed') {
			this.isWorking = false;
			this.completed = false;
			this.hasError = true;
			this.status = `Stopped due to a non-retryable error:\n${result.errorMessage ?? 'Unknown error'}`;
			this.#stopPolling();
			this.#clearActiveJob();
			return;
		}

		const progressText = result.estimatedTotalMessages
			? ` of ~${result.estimatedTotalMessages.toLocaleString()}`
			: '';
		this.status = `Scanned ${result.scannedMessages.toLocaleString()}${progressText} messages.\nFound ${result.uniqueSenders.toLocaleString()} unique senders.`;
	}
}

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

function getErrorStatusCode(errorValue: unknown): number | null {
	if (typeof errorValue === 'object' && errorValue !== null) {
		const status = (errorValue as { status?: unknown }).status;
		if (typeof status === 'number' && Number.isFinite(status)) return status;
	}

	const message = getErrorMessage(errorValue);
	const explicitMatch =
		message.match(/status(?: code)?\s*(\d{3})/i) ?? message.match(/error\s*(\d{3})/i);
	if (explicitMatch) return Number.parseInt(explicitMatch[1], 10);

	const knownMatch = message.match(/\b(400|401|403|404|408|425|429|500|502|503|504)\b/);
	if (knownMatch) return Number.parseInt(knownMatch[1], 10);

	return null;
}
