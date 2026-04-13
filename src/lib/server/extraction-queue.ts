import { processExtractionJobChunk } from '$lib/server/extraction-jobs';

export type ExtractionQueueMessage = {
	jobId: string;
	jobKey: string;
};

type ExtractionQueueEnv = {
	loop_extract_emails_prod: D1Database;
	EXTRACTION_QUEUE: Queue<ExtractionQueueMessage>;
};

export async function enqueueExtractionJob(
	queue: Queue<ExtractionQueueMessage>,
	message: ExtractionQueueMessage
): Promise<void> {
	await queue.send(message, { contentType: 'json' });
}

export async function handleExtractionQueueBatch(
	batch: MessageBatch<unknown>,
	env: ExtractionQueueEnv
): Promise<void> {
	for (const message of batch.messages) {
		if (!isExtractionQueueMessage(message.body)) {
			console.warn('Ignoring malformed extraction queue message');
			continue;
		}

		const result = await processExtractionJobChunk({
			db: env.loop_extract_emails_prod,
			jobId: message.body.jobId,
			jobKey: message.body.jobKey
		});

		if (!result.done) {
			await enqueueExtractionJob(env.EXTRACTION_QUEUE, message.body);
		}
	}
}

function isExtractionQueueMessage(value: unknown): value is ExtractionQueueMessage {
	if (typeof value !== 'object' || value === null) return false;

	const record = value as Record<string, unknown>;
	return typeof record.jobId === 'string' && typeof record.jobKey === 'string';
}
