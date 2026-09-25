import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const customers = sqliteTable('customers', {
	customerId: integer('customer_id').primaryKey(),
	companyName: text('company_name'),
	contactName: text('contact_name'),
});

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
