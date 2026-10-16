CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`category_id` text NOT NULL,
	`monthly_amount` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_household_category_uq` ON `budgets` (`household_id`,`category_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_household_kind_name_uq` ON `categories` (`household_id`,`kind`,`name`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text,
	`category_id` text,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`occurred_on` text NOT NULL,
	`merchant` text,
	`note` text,
	`source` text DEFAULT 'web' NOT NULL,
	`external_ref` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tx_household_date_idx` ON `transactions` (`household_id`,`occurred_on`);--> statement-breakpoint
CREATE INDEX `tx_household_category_idx` ON `transactions` (`household_id`,`category_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tx_external_ref_uq` ON `transactions` (`household_id`,`source`,`external_ref`) WHERE "transactions"."external_ref" IS NOT NULL;