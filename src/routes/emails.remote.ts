import * as v from 'valibot';
import { command, getRequestEvent } from '$app/server';

async function hashUser(user: string, salt: string) {
	const data = new TextEncoder().encode(user + salt);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const storeEmails = command(
	v.object({
		user: v.string(),
		emails: v.array(v.string())
	}),
	async ({ user, emails }) => {
		const { platform } = getRequestEvent();
		const db = platform?.env.loop_extract_emails_prod;
		const salt = platform?.env.USER_HASH_SALT;

		if (!db) throw new Error('D1 binding not configured');
		if (!salt) throw new Error('USER_HASH_SALT not configured');

		const userHash = await hashUser(user, salt);

		await db.exec('BEGIN');

		try {
			for (const email of emails) {
				// insert email if new
				await db.prepare('INSERT OR IGNORE INTO emails (email) VALUES (?)').bind(email).run();

				// get email id
				const row = await db
					.prepare('SELECT id FROM emails WHERE email = ?')
					.bind(email)
					.first<{ id: number }>();

				if (!row) continue;

				// attempt unique submission insert
				await db
					.prepare('INSERT OR IGNORE INTO email_submissions (email_id, user_hash) VALUES (?, ?)')
					.bind(row.id, userHash)
					.run();
			}
			await db.exec('COMMIT');
		} catch (err) {
			await db.exec('ROLLBACK');
			throw err;
		}

		return { success: true };
	}
);
