/** 9a's Retry and 9i's Try again: one bounded presence check (spec 2026-10-02-mobile-app-design § 5). */
export const RETRY_WINDOW_MS = 5_000
/** Messages per transcript page on the phone (spec § 5, parent § 4): one page must fit one relay frame. */
export const TRANSCRIPT_PAGE_SIZE = 30
/** How long the cache waits for the store to settle before writing it out. */
export const CACHE_WRITE_DEBOUNCE_MS = 2_000
/** After `paired`, how long 9e waits for the Mac's hello before showing "Paired with" anyway. */
export const PAIRED_HELLO_WAIT_MS = 10_000
/** How often relative times on screen ("3m", "as of") are re-read. */
export const CLOCK_TICK_MS = 30_000
