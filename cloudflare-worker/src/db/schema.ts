import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const customers = sqliteTable('customers', {
	customerId: integer('customer_id').primaryKey(),
	companyName: text('company_name'),
	contactName: text('contact_name'),
});

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

// Where the last run left off in Gmail's change log. History ids run past 2^53, so they
// stay text the whole way through and are never parsed into a number.
export const syncState = sqliteTable('sync_state', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
});
