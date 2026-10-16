CREATE TABLE `insights` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`month` text NOT NULL,
	`created_by` text,
	`input_json` text NOT NULL,
	`result_json` text NOT NULL,
	`mock` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `insights_household_month_idx` ON `insights` (`household_id`,`month`);