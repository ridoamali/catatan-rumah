CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`created_by` text,
	`title` text NOT NULL,
	`amount` integer,
	`due_date` text NOT NULL,
	`repeat` text DEFAULT 'none' NOT NULL,
	`note` text,
	`status` text DEFAULT 'active' NOT NULL,
	`completed_at` integer,
	`completed_due_date` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `reminders_household_due_idx` ON `reminders` (`household_id`,`due_date`);