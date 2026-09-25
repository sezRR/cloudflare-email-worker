import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` needs no credentials. The d1-http driver is only used by
// `drizzle-kit studio` / `push` against the remote database.
export default defineConfig({
	dialect: 'sqlite',
	schema: './src/db/schema.ts',
	out: './drizzle/migrations',
	driver: 'd1-http',
	dbCredentials: {
		accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
		databaseId: '102ebc09-bd86-4c0c-98da-00deea852955',
		token: process.env.CLOUDFLARE_D1_TOKEN!,
	},
});
