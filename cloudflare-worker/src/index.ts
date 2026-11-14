import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { timingSafeEqual } from 'hono/utils/buffer';
import * as schema from './db/schema';
import { processInbox } from './cron';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/beverages', async (c) => {
	const db = drizzle(c.env.prod_d1_tutorial, { schema });
	const results = await db.select().from(schema.customers).where(eq(schema.customers.companyName, 'Bs Beverages'));
	return c.json(results);
});

// Runs the same job as the cron, on demand. It labels mail and spends TypeSafe credit, so
// it sits behind a token rather than being open to anyone who finds the URL.
app.post('/api/run', bearerAuth<{ Bindings: Env }>({ verifyToken: (token, c) => timingSafeEqual(token, c.env.RUN_TOKEN) }), async (c) => {
	console.log(`Manual run at ${new Date().toISOString()}`);

	// Awaited rather than handed to waitUntil: work after the response only gets 30 seconds,
	// and a backlog can take longer than that.
	return c.json({ ok: true, ...(await processInbox(c.env)) });
});

// The default handler logs the stack across several lines and answers a bare 500; log the
// message whole and hand it back, so the CLI shows why a run failed. Every route that can
// throw sits behind Access, so the detail does not leak to the open internet.
app.onError((error, c) => {
	console.error(`${c.req.method} ${c.req.path} failed: ${error.message}`, error.stack);
	return c.json({ ok: false, error: error.message }, 500);
});

app.get('*', (c) => c.text('Call /api/beverages to see everyone who works at Bs Beverages'));

export default {
	fetch: app.fetch,

	async scheduled(controller, env, ctx): Promise<void> {
		console.log(`Cron "${controller.cron}" fired at ${new Date(controller.scheduledTime).toISOString()}`);
		ctx.waitUntil(processInbox(env));
	},
} satisfies ExportedHandler<Env>;
