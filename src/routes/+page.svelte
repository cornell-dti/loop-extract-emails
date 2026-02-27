<script lang="ts">
	import { env } from '$env/dynamic/public';
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';

	const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
	const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
	const GOOGLE_CLIENT_ID = env.PUBLIC_GOOGLE_CLIENT_ID;

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

	let tokenClient: TokenClient | null = null;
	let status = $state('Loading Google sign-in...');
	let isWorking = $state(false);
	let scannedMessages = $state(0);
	let estimatedTotalMessages = $state<number | null>(null);

	onMount(() => {
		if (!GOOGLE_CLIENT_ID) {
			status = 'Missing PUBLIC_GOOGLE_CLIENT_ID. Add it to your environment and reload.';
			return;
		}

		let cancelled = false;

		void (async () => {
			try {
				await loadGoogleIdentityScript();
				if (cancelled) return;

				const oauth2 = getGoogleNamespace()?.accounts?.oauth2;
				if (!oauth2) throw new Error('Google OAuth client failed to initialize.');

				tokenClient = oauth2.initTokenClient({
					client_id: GOOGLE_CLIENT_ID,
					scope: GOOGLE_SCOPE,
					callback: (response: TokenResponse) => {
						void handleTokenResponse(response);
					}
				});

				status = 'Ready. Click "Sign in with Google".';
			} catch (error) {
				console.error(error);
				status = 'Unable to load Google sign-in.';
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	async function signInWithGoogle() {
		if (isWorking) return;

		if (!tokenClient) {
			status = 'Google sign-in is still loading.';
			return;
		}

		status = 'Waiting for Google authorization...';
		tokenClient.requestAccessToken({ prompt: 'consent' });
	}

	async function handleTokenResponse(response: TokenResponse) {
		if (response.error) {
			status = `Google sign-in failed: ${response.error_description ?? response.error}`;
			return;
		}

		const accessToken = response.access_token;
		if (!accessToken) {
			status = 'Google sign-in returned no access token.';
			return;
		}

		scannedMessages = 0;
		estimatedTotalMessages = null;
		isWorking = true;
		status = 'Reading mailbox history. This can take a while for large inboxes...';

		try {
			const { ownEmail, senders } = await collectUniqueSenderEmails(accessToken);
			console.log('Your email:', ownEmail);
			console.log('Unique sender emails:', senders);
			status = `Done. Logged ${senders.length.toLocaleString()} unique sender emails to the console.`;
		} catch (error) {
			console.error(error);
			status = 'Failed to read mailbox data. Check console for details.';
		} finally {
			isWorking = false;
		}
	}

	const BATCH_SIZE = 100; // Gmail batch API max
	const MAX_RETRIES = 5;
	const BATCH_DELAY_MS = 600; // ~100 batches/min = ~10k individual requests/min, well under 15k

	async function collectUniqueSenderEmails(
		accessToken: string
	): Promise<{ ownEmail: string | null; senders: string[] }> {
		const profile = await gmailFetch<GmailProfileResponse>(
			'https://gmail.googleapis.com/gmail/v1/users/me/profile',
			accessToken
		);
		const ownEmail = profile.emailAddress?.toLowerCase() ?? null;
		estimatedTotalMessages =
			typeof profile.messagesTotal === 'number' && profile.messagesTotal > 0
				? profile.messagesTotal
				: null;

		const unique = new SvelteSet<string>();
		let nextPageToken: string | undefined;
		let processed = 0;

		do {
			const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
			listUrl.searchParams.set('maxResults', '500');
			listUrl.searchParams.set('includeSpamTrash', 'true');
			if (nextPageToken) listUrl.searchParams.set('pageToken', nextPageToken);

			const page = await gmailFetch<GmailListResponse>(listUrl.toString(), accessToken);
			const messageIds = page.messages?.map((m) => m.id) ?? [];

			// Process in batches of 100 via the Gmail batch endpoint
			for (const batch of chunk(messageIds, BATCH_SIZE)) {
				const fromHeaders = await batchGetFromHeaders(batch, accessToken);

				for (const header of fromHeaders) {
					for (const email of extractEmails(header)) {
						if (email !== ownEmail) {
							unique.add(email);
						}
					}
				}

				// Throttle between batches to stay under quota
				if (messageIds.length > BATCH_SIZE) {
					await sleep(BATCH_DELAY_MS);
				}
			}

			processed += messageIds.length;
			scannedMessages = processed;
			if (estimatedTotalMessages !== null && scannedMessages > estimatedTotalMessages) {
				estimatedTotalMessages = scannedMessages;
			}
			const progressText = estimatedTotalMessages
				? ` of ~${estimatedTotalMessages.toLocaleString()}`
				: '';
			status = `Scanned ${processed.toLocaleString()}${progressText} messages.\nFound ${unique.size.toLocaleString()} unique senders.`;
			nextPageToken = page.nextPageToken;
		} while (nextPageToken);

		return { ownEmail, senders: [...unique].sort((a, b) => a.localeCompare(b)) };
	}

	/**
	 * Uses the Gmail batch API to fetch From headers for up to 100 messages
	 * in a single HTTP request. Falls back to individual fetches on parse failure.
	 */
	async function batchGetFromHeaders(messageIds: string[], accessToken: string): Promise<string[]> {
		const boundary = `batch_${crypto.randomUUID()}`;

		const parts = messageIds.map(
			(id) =>
				`--${boundary}\r\nContent-Type: application/http\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From HTTP/1.1\r\n\r\n`
		);

		const body = parts.join('') + `--${boundary}--`;

		const response = await fetchWithRetry('https://www.googleapis.com/batch/gmail/v1', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${accessToken}`,
				'Content-Type': `multipart/mixed; boundary=${boundary}`
			},
			body
		});

		const responseText = await response.text();
		return parseBatchResponse(responseText);
	}

	/**
	 * Parses a multipart/mixed batch response and extracts From header values.
	 * The response looks like:
	 *   --batch_boundary
	 *   Content-Type: application/http
	 *
	 *   HTTP/1.1 200 OK
	 *   Content-Type: application/json
	 *
	 *   { "id": "...", "payload": { "headers": [...] } }
	 *   --batch_boundary--
	 */
	function parseBatchResponse(responseText: string): string[] {
		const results: string[] = [];

		// Split on the boundary (first line of the response is `--<boundary>`)
		// Each part contains an HTTP response with a JSON body after a blank line pair
		const parts = responseText.split(/--batch_\S+/);

		for (const part of parts) {
			// Find the JSON body: it starts after the blank line that follows the HTTP headers
			const jsonStart = part.indexOf('{');
			const jsonEnd = part.lastIndexOf('}');
			if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) continue;

			try {
				const msg = JSON.parse(part.slice(jsonStart, jsonEnd + 1)) as GmailMessageResponse;
				const from = msg.payload?.headers?.find((h) => h.name?.toLowerCase() === 'from');
				results.push(from?.value ?? '');
			} catch {
				// Skip unparseable parts (e.g. the closing boundary)
			}
		}

		return results;
	}

	function extractEmails(headerValue: string): string[] {
		const matches = headerValue.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
		if (!matches) return [];
		return matches.map((e) => e.toLowerCase());
	}

	/**
	 * fetch() with exponential backoff on 429 and 403 rate-limit errors.
	 */
	async function fetchWithRetry(url: string, init: RequestInit, attempt = 0): Promise<Response> {
		const response = await fetch(url, init);

		if ((response.status === 429 || response.status === 403) && attempt < MAX_RETRIES) {
			const backoff = Math.min(1000 * 2 ** attempt, 32_000);
			const jitter = Math.random() * 1000;
			const delay = backoff + jitter;
			status = `Rate limited. Retrying in ${Math.round(delay / 1000)}s...`;
			await sleep(delay);
			return fetchWithRetry(url, init, attempt + 1);
		}

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Gmail API error ${response.status}: ${body}`);
		}

		return response;
	}

	async function gmailFetch<T>(url: string, accessToken: string): Promise<T> {
		const response = await fetchWithRetry(url, {
			headers: { Authorization: `Bearer ${accessToken}` }
		});
		return (await response.json()) as T;
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

	function progressPercent(): number | null {
		if (!estimatedTotalMessages || estimatedTotalMessages <= 0) return null;
		const percent = (scannedMessages / estimatedTotalMessages) * 100;

		if (isWorking && percent >= 100) {
			return 99;
		}

		return Math.min(100, Math.max(0, Math.round(percent)));
	}

	function progressValue(): number | undefined {
		if (!estimatedTotalMessages || estimatedTotalMessages <= 0) return undefined;

		if (isWorking && scannedMessages >= estimatedTotalMessages) {
			return estimatedTotalMessages * 0.99;
		}

		return Math.min(scannedMessages, estimatedTotalMessages);
	}

	function loadGoogleIdentityScript(): Promise<void> {
		if (getGoogleNamespace()?.accounts?.oauth2) return Promise.resolve();

		const existing = document.querySelector<HTMLScriptElement>(
			`script[src="${GOOGLE_IDENTITY_SCRIPT}"]`
		);
		if (existing) {
			return waitForGoogleIdentity();
		}

		return new Promise<void>((resolve, reject) => {
			const script = document.createElement('script');
			script.src = GOOGLE_IDENTITY_SCRIPT;
			script.async = true;
			script.defer = true;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error('Failed to load Google identity script.'));
			document.head.append(script);
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
</script>

<main class="shell">
	<button
		class="google-button"
		onclick={signInWithGoogle}
		disabled={!GOOGLE_CLIENT_ID || isWorking}
	>
		{isWorking ? 'Scanning inbox...' : 'Sign in with Google'}
	</button>

	{#if isWorking || scannedMessages > 0}
		<div class="progress-wrap">
			<div class="progress-meta">
				<span>{scannedMessages.toLocaleString()} scanned</span>
				<span>{progressPercent() === null ? 'Estimating total...' : `${progressPercent()}%`}</span>
			</div>
			<progress class="progress" max={estimatedTotalMessages ?? 1} value={progressValue()}
			></progress>
		</div>
	{/if}

	<p class="status">{status}</p>
</main>

<style>
	:global(body) {
		margin: 0;
		min-height: 100dvh;
		font-family: 'Trebuchet MS', 'Segoe UI', sans-serif;
		background:
			radial-gradient(circle at 20% 20%, #1d4ed8 0%, transparent 40%),
			radial-gradient(circle at 80% 10%, #0ea5e9 0%, transparent 35%),
			radial-gradient(circle at 50% 100%, #0f172a 0%, #020617 62%);
		color: #e2e8f0;
	}

	.shell {
		min-height: 100dvh;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 1rem;
		padding: 1.5rem;
		width: min(34rem, 94vw);
		margin-inline: auto;
		text-align: center;
	}

	.google-button {
		cursor: pointer;
		border: 1px solid #f8fafc80;
		border-radius: 999px;
		padding: 0.9rem 1.6rem;
		font-size: 1rem;
		font-weight: 700;
		color: #020617;
		background: linear-gradient(135deg, #f8fafc, #cbd5e1);
		box-shadow: 0 12px 32px #02061766;
		transition:
			transform 180ms ease,
			box-shadow 180ms ease,
			opacity 180ms ease;
	}

	.google-button:hover:enabled {
		transform: translateY(-2px);
		box-shadow: 0 16px 36px #0206178c;
	}

	.google-button:disabled {
		cursor: not-allowed;
		opacity: 0.65;
	}

	.progress-wrap {
		width: min(28rem, 100%);
		display: grid;
		gap: 0.35rem;
	}

	.progress-meta {
		display: flex;
		justify-content: space-between;
		font-size: 0.85rem;
		color: #cbd5e1;
		font-variant-numeric: tabular-nums;
	}

	.progress-meta span:last-child {
		min-width: 5ch;
		text-align: right;
	}

	.progress {
		width: 100%;
		height: 0.7rem;
		appearance: none;
		-webkit-appearance: none;
		border: 0;
		border-radius: 999px;
		overflow: hidden;
		background: #0b1220;
		box-shadow: inset 0 0 0 1px #93c5fd66;
	}

	.progress::-webkit-progress-bar {
		background: #0b1220;
		border-radius: 999px;
	}

	.progress::-webkit-progress-value {
		background: linear-gradient(90deg, #38bdf8, #60a5fa);
		border-radius: 999px;
	}

	.progress::-moz-progress-bar {
		background: linear-gradient(90deg, #38bdf8, #60a5fa);
		border-radius: 999px;
	}

	.status {
		margin: 0 auto;
		width: min(28rem, 100%);
		max-width: 40ch;
		font-size: 0.95rem;
		line-height: 1.45;
		color: #cbd5e1;
		text-align: center;
	}
</style>
