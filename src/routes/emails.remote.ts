import * as v from 'valibot';
import { command, getRequestEvent } from '$app/server';

const EMAIL_BATCH_SIZE = 50;

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

		return { success: true };
	}
);
