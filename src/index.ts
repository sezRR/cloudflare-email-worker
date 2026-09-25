import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as schema from './db/schema';
import { runScheduledJob } from './cron';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/beverages', async (c) => {
	const db = drizzle(c.env.prod_d1_tutorial, { schema });
	const results = await db.select().from(schema.customers).where(eq(schema.customers.companyName, 'Bs Beverages'));
	return c.json(results);
});

app.get('*', (c) => c.text('Call /api/beverages to see everyone who works at Bs Beverages'));

export default {
	fetch: app.fetch,

	async scheduled(controller, env, ctx): Promise<void> {
		ctx.waitUntil(runScheduledJob(controller, env));
	},
} satisfies ExportedHandler<Env>;
