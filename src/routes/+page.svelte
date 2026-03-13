<script lang="ts">
	import { onMount } from 'svelte';
	import { storeWaitlistEmail } from './emails.remote';

	// @ts-ignore
	import stampCard from '$lib/assets/mail stamp card.svg?url';
	// @ts-ignore
	import loopLogo from '$lib/assets/Loop-logo.svg?url';
	// @ts-ignore
	import tagFun from '$lib/assets/just for fun.svg?url';
	// @ts-ignore
	import tagEvents from '$lib/assets/club events.svg?url';
	// @ts-ignore
	import tagCareer from '$lib/assets/career opportunities.svg?url';
	// @ts-ignore
	import badge from '$lib/assets/cornell badge.png?url';
	// @ts-ignore
	import emailLogos from '$lib/assets/email logos.png?url';
	// @ts-ignore
	import mockup from '$lib/assets/mockup.png?url';
	// @ts-ignore
	import background from '$lib/assets/background.png?url';

	let email = $state('');
	let submitting = $state(false);
	let submitted = $state(false);
	let consenting = $state(false);
	let consented = $state(false);
	let errorMsg = $state('');

	let loopySvg: SVGSVGElement | null = $state(null);
	let leftPupilOffset = $state({ x: 0, y: 0 });
	let rightPupilOffset = $state({ x: 0, y: 0 });

	// Eye white centers in SVG coordinate space (viewBox 0 0 131 126)
	const LEFT_EYE = { x: 48.2, y: 52.3 };
	const RIGHT_EYE = { x: 81.0, y: 56.3 };
	const MAX_RADIUS = 3;

	onMount(() => {
		function onMouseMove(e: MouseEvent) {
			if (!loopySvg) return;
			const rect = loopySvg.getBoundingClientRect();
			const mx = ((e.clientX - rect.left) / rect.width) * 131;
			const my = ((e.clientY - rect.top) / rect.height) * 126;

			for (const [eye, isLeft] of [[LEFT_EYE, true], [RIGHT_EYE, false]] as const) {
				const dx = mx - eye.x;
				const dy = my - eye.y;
				const dist = Math.hypot(dx, dy);
				const f = dist > 0 ? Math.min(dist, MAX_RADIUS) / dist : 0;
				const offset = { x: dx * f, y: dy * f };
				if (isLeft) leftPupilOffset = offset;
				else rightPupilOffset = offset;
			}
		}

		window.addEventListener('mousemove', onMouseMove);
		return () => window.removeEventListener('mousemove', onMouseMove);
	});

	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!email) {
			errorMsg = 'Please fill out this field.';
			return;
		}
		if (submitting) return;
		submitting = true;
		errorMsg = '';
		try {
			await storeWaitlistEmail({ email });
			submitted = true;
		} catch {
			errorMsg = 'Something went wrong. Please try again.';
		} finally {
			submitting = false;
		}
	}
</script>

<main style="background-image: url('{background}')">
	<div class="hero">
		<!-- #Just for fun! speech bubble — upper left -->
		<div class="floater tag-fun">
			<img src={tagFun} alt="#Just for fun!" />
		</div>

		<!-- Cornell DTI badge — left middle -->
		<div class="floater badge">
			<img src={badge} alt="Cornell DTI badge" />
		</div>

		<!-- Gmail icons — upper right (large, overlapping stamp right) -->
		<div class="floater gmail">
			<img src={emailLogos} alt="" />
		</div>

		<!-- #Career opportunities speech bubble — lower left -->
		<div class="floater tag-career">
			<img src={tagCareer} alt="#Career opportunities" />
		</div>

		<!-- #club events pill — lower right, below stamp card -->
		<div class="floater tag-events">
			<img src={tagEvents} alt="#club events" />
		</div>

		<!-- Stamp card with mascot anchored to its top-right -->
		<div class="stamp-wrapper">
			<svg class="mascot" width="131" height="126" viewBox="0 0 131 126" fill="none" xmlns="http://www.w3.org/2000/svg" bind:this={loopySvg} aria-hidden="true">
				<path d="M15.0257 77.4706C14.9282 77.4952 14.6616 77.7423 13.155 80.3981C11.8012 82.7844 9.50731 87.4206 8.14496 89.9703C6.7826 92.5201 6.48679 92.879 6.15629 93.189C5.82579 93.4989 5.46956 93.749 5.10254 94.0066" stroke="#313131" stroke-width="3.39214" stroke-linecap="round"/>
				<path d="M109.405 76.5681C109.392 76.5478 109.796 76.7328 111.003 77.568C111.8 78.2078 112.971 79.286 115.534 82.0808C118.097 84.8756 122.018 89.3542 126.057 93.9686" stroke="#313131" stroke-width="3.39214" stroke-linecap="round"/>
				<path d="M43.1025 90.6754C43.0726 90.6648 43.0427 90.6542 42.9561 94.5809C42.8695 98.5076 37.1112 98.1564 36.9241 102.205C36.7371 106.254 42.1256 114.464 41.3451 114.243C37.4993 113.157 36.1317 112.991 35.073 113.084C34.6748 113.119 34.6017 113.382 34.7536 113.586C35.9973 114.276 37.3508 114.449 38.537 114.403C38.979 114.328 39.0962 114.148 39.2636 113.852" stroke="#313131" stroke-width="3.39214" stroke-linecap="round"/>
				<path d="M79.1926 93.2423C79.1862 93.2327 79.1798 93.2231 79.5168 95.6917C79.8539 98.1603 72.8154 102.518 73.3583 106.253C73.9012 109.988 83.4477 116.132 83.7038 117.519C84.124 119.794 82.9973 117.185 82.9713 117.519C82.9024 118.407 80.1927 117.616 78.2853 118.08C77.9257 118.168 77.788 118.411 77.6837 118.62C77.5795 118.829 77.5381 119.068 77.6076 119.287C77.7531 119.745 78.4073 119.982 79.0973 120.11C80.1749 120.311 81.1954 119.686 82.0822 119.075C82.2597 118.914 82.4129 118.746 82.5186 118.567C82.6243 118.388 82.6779 118.205 82.767 117.965" stroke="#313131" stroke-width="3.39214" stroke-linecap="round"/>
				<g filter="url(#filter0_d_238_93)">
					<path d="M112.129 83.1536C110.39 97.3108 97.5047 107.378 83.3475 105.64L35.9549 99.8209C21.7978 98.0826 11.7304 85.1968 13.4686 71.0397C15.2069 56.8826 28.0927 46.8151 42.2498 48.5534L89.6424 54.3725C103.8 56.1108 113.867 68.9965 112.129 83.1536Z" fill="#EB7128"/>
					<path d="M117.692 37.8475C115.953 52.0046 113.571 75.8461 99.4139 74.1078L28.8886 65.0521C14.7315 63.3138 17.2933 39.8907 19.0315 25.7336C20.4299 14.3451 29.0419 5.60311 39.7265 3.52429C45.0094 2.49643 50.298 4.40309 55.1781 6.67255C64.6834 11.093 75.312 12.5049 85.6417 10.7194L87.0498 10.476C92.4574 9.54132 98.1641 9.00683 103.123 11.3568C112.907 15.9928 119.083 26.5127 117.692 37.8475Z" fill="#EB7128"/>
					<rect x="39.9387" y="37.7844" width="19.9658" height="26.8197" rx="9.9829" transform="rotate(7 39.9387 37.7844)" fill="white"/>
					<g transform="translate({leftPupilOffset.x}, {leftPupilOffset.y - 4})">
						<rect x="41.9944" y="47.7791" width="11.5358" height="15.7656" rx="5.76791" transform="rotate(7 41.9944 47.7791)" fill="#3D3D3D"/>
					</g>
					<rect x="72.7705" y="41.8157" width="19.9658" height="26.8197" rx="9.9829" transform="rotate(7 72.7705 41.8157)" fill="white"/>
					<path d="M57.2373 72.9532C60.1315 76.0235 66.881 79.8689 70.7258 70.6878" stroke="#3D3D3D" stroke-width="2.97997" stroke-linecap="round"/>
					<g transform="translate({rightPupilOffset.x}, {rightPupilOffset.y - 4})">
						<rect x="74.2188" y="51.5608" width="11.5358" height="15.7656" rx="5.76791" transform="rotate(7 74.2188 51.5608)" fill="#3D3D3D"/>
					</g>
				</g>
				<defs>
					<filter id="filter0_d_238_93" x="6.79627" y="-5.76973e-05" width="117.568" height="115.551" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
						<feFlood flood-opacity="0" result="BackgroundImageFix"/>
						<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
						<feOffset dy="3.23858"/>
						<feGaussianBlur stdDeviation="3.23858"/>
						<feComposite in2="hardAlpha" operator="out"/>
						<feColorMatrix type="matrix" values="0 0 0 0 0.145246 0 0 0 0 0.370876 0 0 0 0 0.568303 0 0 0 0.4 0"/>
						<feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_238_93"/>
						<feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_238_93" result="shape"/>
					</filter>
				</defs>
			</svg>
			<div class="stamp-card">
				<img class="stamp-bg" src={stampCard} alt="" />
				<div class="stamp-content">
					{#if !submitted}
						<img src={loopLogo} alt="Loop" class="loop-logo" />
						<p class="tagline">Your Cornell news, curated.</p>
					{/if}

					{#if submitted && !consented}
						<div class="consent-screen">
							<img src={loopLogo} alt="Loop" class="loop-logo" />
							<p class="success">You're on the list!</p>
							<div class="consent-body">
								<p class="consent-heading">Do you consent to inbox sender scanning?</p>
								<p class="consent-desc">By clicking Consent, you allow Loop to securely scan your Gmail metadata to identify unique senders. You can request deletion anytime.</p>
							</div>
							{#if consenting}
							<div class="progress-track">
								<div class="progress-fill" onanimationend={() => consented = true}></div>
							</div>
						{:else}
							<button type="button" class="consent-btn" onclick={() => consenting = true}>Consent</button>
						{/if}
						</div>
					{:else if consented}
						<img src={loopLogo} alt="Loop" class="loop-logo" />
						<p class="success">Inbox scan successful!</p>
						<p class="thank-you">Thank you for joining Loop. We'll curate your Cornell news and be in touch soon.</p>
					{:else}
						<form onsubmit={handleSubmit} novalidate>
							<input
								type="email"
								placeholder="Enter Email"
								bind:value={email}
								disabled={submitting}
							/>
							<button type="submit" disabled={submitting}>
								{submitting ? 'Joining...' : 'Join Waitlist'}
							</button>
						</form>
						{#if errorMsg}
							<p class="error">{errorMsg}</p>
						{/if}
					{/if}
				</div>
			</div>
		</div>
	</div>

	<!-- Browser screenshot mockup -->
	<div class="mockup-strip">
		<img src={mockup} alt="Loop Gmail extension preview" />
	</div>
</main>

<style>
	:global(html, body) {
		margin: 0;
		min-height: 100dvh;
		font-family: 'Manrope', sans-serif;
	}

	main {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		position: relative;
		background-size: cover;
		background-position: center top;
	}

	/* ── Hero ────────────────────────────────────────────── */
	.hero {
		flex: 1;
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		width: 100%;
		max-width: 1000px;
		max-height: 800px;
		margin: 0 auto;
		padding: 4rem 1rem 2rem;
		box-sizing: border-box;
	}

	/* ── Stamp card + mascot wrapper ─────────────────────── */
	/*
	 * The wrapper is the flex child that centers the stamp.
	 * Mascot is absolutely positioned within it, anchored to
	 * the top-right corner of the stamp card.
	 * Figma measurements (design units → CSS at 420px stamp):
	 *   loopy width:            95 × (420/462) ≈ 86px  → 22% of wrapper
	 *   loopy extends past right: 11.96 × (420/462) ≈ 11px → right: -2.6%
	 *   loopy feet overlap stamp: 17.1 × (420/462) ≈ 15.5px → bottom: calc(100% - 16px)
	 */
	.stamp-wrapper {
		position: relative;
		z-index: 1;
		width: min(420px, 80vw);
	}

	.stamp-card {
		width: 100%;
		aspect-ratio: 462 / 345;
		position: relative;
	}

	.stamp-bg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: fill;
	}

	.stamp-content {
		position: relative;
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.85rem;
		padding: 14% 12%;
		box-sizing: border-box;
		text-align: center;
		top: -5% !important;
	}

	/*
	 * Loopy sits on top of the stamp card, slightly right of center.
	 * left: 55% of wrapper + translateX(-50%) centers the mascot at 55% of stamp width.
	 * bottom: calc(100% - 16px) → feet rest 16px below the stamp's top edge.
	 */
	.mascot {
		position: absolute;
		width: 28%; /* ≈ 92px at 420px stamp */
		left: 81%;
		transform: translateX(-50%);
		bottom: 90%;
		z-index: 2;
		height: auto;
	}

	.loop-logo {
		width: 165px;
		height: auto;
	}

	.tagline {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 500;
		color: rgba(0, 0, 0, 0.55);
	}

	form {
		display: flex;
		gap: 4px;
		width: 100%;
	}

	input[type='email'] {
		flex: 1;
		border: 1px solid #d4d4d4;
		border-radius: 8px;
		padding: 0.55rem 0.75rem;
		font-family: 'Manrope', sans-serif;
		font-size: 0.875rem;
		font-weight: 500;
		color: #111;
		background: #f8fafd;
		outline: none;
		transition: border-color 150ms;
		min-width: 0;
	}

	input[type='email']:focus {
		border-color: #eb7128;
	}

	input[type='email']::placeholder {
		color: #636465;
	}

	button[type='submit'] {
		border: none;
		border-radius: 8px;
		padding: 0.55rem 0.875rem;
		font-family: 'Manrope', sans-serif;
		font-size: 0.875rem;
		font-weight: 500;
		color: white;
		background: #eb7128;
		cursor: pointer;
		white-space: nowrap;
		transition: opacity 150ms;
	}

	button[type='submit']:hover:not(:disabled) {
		opacity: 0.9;
	}

	button[type='submit']:disabled {
		opacity: 0.65;
		cursor: not-allowed;
	}

	.consent-screen {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.85rem;
		transform: translateY(4%);
	}

	.consent-body {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		text-align: center;
	}

	.consent-heading {
		margin: 0;
		font-size: 0.875rem;
		font-weight: 600;
		color: #00304e;
	}

	.consent-desc {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 400;
		color: #00304e;
		opacity: 0.8;
		line-height: 1.4;
	}

	.progress-track {
		width: 100%;
		height: 10px;
		background: #f0e8e1;
		border-radius: 999px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		width: 0%;
		background: #eb7128;
		border-radius: 999px;
		animation: fill-progress 2s ease-in-out forwards;
	}

	@keyframes fill-progress {
		from { width: 0%; }
		to { width: 100%; }
	}

	.consent-btn {
		border: none;
		border-radius: 8px;
		padding: 0.55rem 1.25rem;
		font-family: 'Manrope', sans-serif;
		font-size: 0.875rem;
		font-weight: 500;
		color: white;
		background: #eb7128;
		cursor: pointer;
		transition: opacity 150ms;
	}

	.consent-btn:hover {
		opacity: 0.9;
	}

	.success {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: #eb7128;
	}

	.thank-you {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 400;
		color: rgba(0, 0, 0, 0.55);
		text-align: center;
		line-height: 1.4;
	}

	.error {
		margin: 0;
		font-size: 0.8rem;
		color: #dc2626;
	}

	/* ── Floaters ────────────────────────────────────────── */
	.floater {
		position: absolute;
	}

	/*
	 * Positions derived from the 1365×768 reference screenshot.
	 * Hero height ≈ 68dvh ≈ 512px at that viewport.
	 * All left/right are % of viewport width; top/bottom are % of hero height.
	 */

	/* #Just for fun! — upper left, above & left of stamp card */
	.tag-fun {
		left: 9%;
		top: 12%;
		transform: rotate(-3deg);
	}
	.tag-fun img {
		width: clamp(130px, 17vw, 200px);
		height: auto;
	}

	/* Cornell DTI badge — middle left, between the two speech bubbles */
	.badge {
		left: 4%;
		top: 39%;
		transform: rotate(-5deg);
	}
	.badge img {
		width: clamp(90px, 13vw, 155px);
		height: auto;
	}

	/*
	 * Gmail icon cluster + blue envelope — top right corner.
	 * email logos.png (286×277) contains both the Gmail M icon badge (top)
	 * and the large blue folder/envelope shape (below it).
	 * Positioned so the Gmail icons appear at the top-right and the blue card
	 * extends below, slightly overlapping the stamp card area.
	 */
	.gmail {
		right: -2%;
		top: 10%;
	}
	.gmail img {
		width: clamp(160px, 21vw, 260px);
		height: auto;
	}

	/* #Career opportunities — lower left, below Cornell badge */
	.tag-career {
		left: 9%;
		top: 78%;
		transform: rotate(13deg);
	}
	.tag-career img {
		width: clamp(170px, 23vw, 280px);
		height: auto;
	}

	/* #club events pill — lower right, below the blue envelope */
	.tag-events {
		right: 5%;
		bottom: 9%;
		transform: rotate(-12deg);
	}
	.tag-events img {
		width: clamp(110px, 15vw, 185px);
		height: auto;
	}

	/* ── Mockup strip ────────────────────────────────────── */
	.mockup-strip {
		height: 32dvh;
		overflow: hidden;
		display: flex;
		justify-content: center;
		align-items: flex-start;
	}

	.mockup-strip img {
		width: min(900px, 95vw);
		height: auto;
		display: block;
	}

	/* ── Tablet ≤768px: hide mockup, adjust hero ─────────── */
	@media (max-width: 768px) {
		.mockup-strip {
			display: none;
		}

		.hero {
			padding: 3rem 1rem 1.5rem;
			max-height: none;
		}
	}

	/* ── Mobile ≤540px: floaters above/below stamp ───────── */
	@media (max-width: 540px) {
		.hero {
			padding-top: 140px;
			padding-bottom: 180px;
			max-height: none;
		}

		.stamp-wrapper {
			width: min(370px, 95vw);
		}

		/* above stamp */
		.tag-fun {
			left: 4%;
			top: 10px;
		}
		.tag-fun img { width: clamp(100px, 32vw, 140px); }

		.gmail {
			right: 4%;
			left: auto;
			top: 5px;
		}
		.gmail img { width: clamp(90px, 30vw, 130px); }

		/* below stamp — row 1: badge left, tag-events right */
		.badge {
			left: 4%;
			top: auto;
			bottom: 95px;
		}
		.badge img { width: clamp(80px, 26vw, 110px); }

		.tag-events {
			right: 4%;
			left: auto;
			bottom: 90px;
		}
		.tag-events img { width: clamp(100px, 32vw, 130px); }

		/* below stamp — row 2: tag-career centered */
		.tag-career {
			left: 50%;
			top: auto;
			bottom: 10px;
			transform: rotate(4deg) translateX(-50%);
		}
		.tag-career img { width: clamp(130px, 40vw, 160px); }

		/* stamp content */
		.stamp-content {
			gap: 0.95rem;
			top: -10px;
		}

		.loop-logo {
			width: 120px;
		}

		.tagline {
			font-size: 12px;
		}

		input[type='email'] {
			padding: 6px 12px;
			font-size: 0.8rem;
		}

		button[type='submit'] {
			padding: 8px;
			font-size: 0.8rem;
		}

		form {
			flex-direction: column;
			width: 80%;
		}
	}
</style>
