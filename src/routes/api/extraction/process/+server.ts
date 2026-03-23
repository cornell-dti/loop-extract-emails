import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { processExtractionJobStep, scheduleExtractionStep } from '$lib/server/extraction-jobs';

export const POST: RequestHandler = async (event) => {
	const db = event.platform?.env.loop_extract_emails_prod;
	if (!db) return json({ ok: false, error: 'D1 binding not configured' }, { status: 500 });

	let payload: unknown;
	try {
		payload = await event.request.json();
	} catch {
		return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
	}

	if (typeof payload !== 'object' || payload === null) {
		return json({ ok: false, error: 'Invalid payload' }, { status: 400 });
	}

	const { jobId, jobKey } = payload as { jobId?: unknown; jobKey?: unknown };
	if (typeof jobId !== 'string' || typeof jobKey !== 'string') {
		return json({ ok: false, error: 'jobId and jobKey are required' }, { status: 400 });
	}

	const { done } = await processExtractionJobStep({ db, jobId, jobKey });

	if (!done) {
		scheduleExtractionStep(event, { jobId, jobKey });
	}

	return json({ ok: true, done });
};
