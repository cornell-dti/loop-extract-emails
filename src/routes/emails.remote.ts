import * as v from 'valibot';
import { command, getRequestEvent } from '$app/server';
import {
	createExtractionJob,
	ensureExtractionTables,
	getExtractionStatus,
	scheduleExtractionStep
} from '$lib/server/extraction-jobs';

export const startEmailExtraction = command(
	v.object({ accessToken: v.string() }),
	async ({ accessToken }) => {
		const event = getRequestEvent();
		const db = event.platform?.env.loop_extract_emails_prod;
		const salt = event.platform?.env.USER_HASH_SALT;

		if (!db) throw new Error('D1 binding not configured');
		if (!salt) throw new Error('USER_HASH_SALT not configured');

		await ensureExtractionTables(db);
		const { jobId, jobKey } = await createExtractionJob({ db, salt, accessToken });

		scheduleExtractionStep(event, { jobId, jobKey });

		return { jobId, jobKey };
	}
);

export const getEmailExtractionStatus = command(
	v.object({ jobId: v.string(), jobKey: v.string() }),
	async ({ jobId, jobKey }) => {
		const event = getRequestEvent();
		const db = event.platform?.env.loop_extract_emails_prod;
		if (!db) throw new Error('D1 binding not configured');

		await ensureExtractionTables(db);
		return getExtractionStatus(db, jobId, jobKey);
	}
);

export const storeWaitlistEmail = command(
	v.object({ email: v.pipe(v.string(), v.email()) }),
	async ({ email }) => {
		const { platform } = getRequestEvent();
		const db = platform?.env.loop_extract_emails_prod;
		if (!db) throw new Error('D1 binding not configured');
		await db.prepare('INSERT OR IGNORE INTO waitlist_emails (email) VALUES (?)').bind(email).run();
		return { success: true };
	}
);
