CREATE TABLE `receipt_scans` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_id` text,
	`status` text NOT NULL,
	`image_path` text,
	`image_bytes` integer,
	`ocr_json` text,
	`mock` integer DEFAULT false NOT NULL,
	`transaction_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `scans_household_status_idx` ON `receipt_scans` (`household_id`,`status`);--> statement-breakpoint
CREATE TABLE `transaction_items` (
	`id` text PRIMARY KEY NOT NULL,
	`transaction_id` text NOT NULL,
	`household_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	`qty` real DEFAULT 1 NOT NULL,
	`unit_price` integer,
	`total` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `items_tx_idx` ON `transaction_items` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `items_household_name_idx` ON `transaction_items` (`household_id`,`name`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `receipt_status` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `receipt_file_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `receipt_url` text;