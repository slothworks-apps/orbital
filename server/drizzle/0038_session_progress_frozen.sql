-- Nullable, so every existing session reads as not frozen and as launched without the dialog's choice.
ALTER TABLE `sessions` ADD `progress_frozen_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `progress_list_choice` integer;
