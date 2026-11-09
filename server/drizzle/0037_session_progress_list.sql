-- Every existing session was started without a progress list.
ALTER TABLE `sessions` ADD `progress_list` integer DEFAULT 0 NOT NULL;
