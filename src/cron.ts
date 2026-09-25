import { drizzle } from 'drizzle-orm/d1';
import * as schema from './db/schema';

export async function runScheduledJob(controller: ScheduledController, env: Env): Promise<void> {
	const db = drizzle(env.prod_d1_tutorial, { schema });

	// TODO: implement the scheduled job
	console.log(`Cron "${controller.cron}" fired at ${new Date(controller.scheduledTime).toISOString()}`);
}
