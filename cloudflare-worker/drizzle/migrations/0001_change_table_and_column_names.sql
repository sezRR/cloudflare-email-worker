ALTER TABLE `Customers` RENAME TO `customers_tmp`;--> statement-breakpoint
ALTER TABLE `customers_tmp` RENAME TO `customers`;--> statement-breakpoint
ALTER TABLE `customers` RENAME COLUMN "CustomerId" TO "customer_id";--> statement-breakpoint
ALTER TABLE `customers` RENAME COLUMN "CompanyName" TO "company_name";--> statement-breakpoint
ALTER TABLE `customers` RENAME COLUMN "ContactName" TO "contact_name";
