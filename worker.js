import app from './.svelte-kit/cloudflare/_worker.js';
import { handleExtractionQueueBatch } from './src/lib/server/extraction-queue';

const worker = {
	fetch(request, env, ctx) {
		return app.fetch(request, env, ctx);
	},
	queue(batch, env) {
		return handleExtractionQueueBatch(batch, env);
	}
};

export default worker;
