import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		const db = drizzle(env.prod_d1_tutorial, { schema });

		if (pathname === '/api/beverages') {
			const results = await db.select().from(schema.customers).where(eq(schema.customers.companyName, 'Bs Beverages'));
			return Response.json(results);
		}

		return new Response('Call /api/beverages to see everyone who works at Bs Beverages');
	},
} satisfies ExportedHandler<Env>;
