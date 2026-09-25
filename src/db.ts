import { eq } from 'drizzle-orm';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';

export type Database = DrizzleD1Database<typeof schema>;

const HISTORY_KEY = 'history_id';

export function createDb(env: Env): Database {
	return drizzle(env.prod_d1_tutorial, { schema });
}

export async function getHistoryId(db: Database): Promise<string | null> {
	const row = await db.query.syncState.findFirst({ where: eq(schema.syncState.key, HISTORY_KEY) });
	return row?.value ?? null;
}

export async function setHistoryId(db: Database, historyId: string): Promise<void> {
	await db
		.insert(schema.syncState)
		.values({ key: HISTORY_KEY, value: historyId })
		.onConflictDoUpdate({ target: schema.syncState.key, set: { value: historyId } });
}
