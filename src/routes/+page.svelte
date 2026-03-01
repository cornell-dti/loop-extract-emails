<script lang="ts">
	import { onMount } from 'svelte';
	import { GmailExtractor } from '$lib/gmail-extractor.svelte';
	import { storeEmails } from './emails.remote';

	const extractor = new GmailExtractor(storeEmails);
	onMount(() => extractor.init());
</script>

<main class="shell">
	<button
		class="google-button"
		onclick={() => extractor.signIn()}
		disabled={extractor.isDisabled}
	>
		{extractor.isWorking ? 'Scanning inbox...' : 'Sign in with Google'}
	</button>

	{#if extractor.isWorking || extractor.scannedMessages > 0}
		<div class="progress-wrap">
			<div class="progress-meta">
				<span>{extractor.scannedMessages.toLocaleString()} scanned</span>
				<span>
					{extractor.progressPercent === null
						? 'Estimating total...'
						: `${extractor.progressPercent}%`}
				</span>
			</div>
			<progress
				class="progress"
				max={extractor.estimatedTotalMessages ?? 1}
				value={extractor.progressValue}
			></progress>
		</div>
	{/if}

	<p class="status">{extractor.status}</p>
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
