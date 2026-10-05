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
/**
 * Blob URLs the image resolver keeps before it revokes the least recently
 * asked (spec § 6.2). Revoking a URL an `<img>` still shows would blank it,
 * so this sits well above one screen of images.
 */
export const IMAGE_URL_CACHE_MAX = 64
/** How long 9g's in-app banner stays before it hides on its own (spec § 6.5). */
export const BANNER_MS = 6_000
/** The longer edge, in px, a photo is brought down to before it leaves the phone (spec § 6.2, parent § 4). */
export const PHOTO_MAX_EDGE = 1568
/** JPEG quality of a downscaled photo, as `canvas.toBlob` takes it (spec § 6.2). */
export const PHOTO_JPEG_QUALITY = 0.85
/**
 * How long a file read over `file_get` may go without a chunk before the
 * viewer says COULDN'T LOAD (spec 2026-10-05-mobile-next § 2, canvas
 * 10e). Re-armed by every chunk, so a slow but moving read is never
 * cut off.
 */
export const FILE_IDLE_TIMEOUT_MS = 10_000
/**
 * The phone's file cache — every image it has shown and every text preview —
 * holds at most this many bytes; past it, the least recently opened entry is
 * dropped first (spec 2026-10-05-mobile-next § 2).
 */
export const FILE_CACHE_MAX_BYTES = 200 * 1024 * 1024
/**
 * The largest text file the phone previews (spec 2026-10-05-mobile-next § 2).
 * The Mac enforces its own cap of the same name and answers 413 above it;
 * this one lets the phone say so for a size it already knows.
 */
export const PHONE_TEXT_PREVIEW_MAX_BYTES = 512 * 1024
/**
 * Complete lines a task's output screen keeps, the newest (spec
 * 2026-10-05-mobile-next § 3, canvas 10g); passed to `appendOutput` as its
 * limit, and the number 10g's footer names.
 */
export const PHONE_OUTPUT_LINES = 2_000
/**
 * The task-output tail the phone asks the Mac for (`taskOutputMaxBytes`, spec
 * 2026-10-05-mobile-next § 3). The tail comes back as a string inside the
 * `http_res` JSON, where JSON escaping can grow a byte up to six times (a
 * control character such as an ANSI escape becomes `\u00XX`); the whole
 * answer must still fit one relay frame (`MAX_INNER_BYTES` on the Mac). So
 * this is kept well under a sixth of that bound, leaving room for the rest
 * of the answer. The newer lines arrive as `task-output` deltas anyway.
 */
export const PHONE_OUTPUT_TAIL_BYTES = 32 * 1024
/**
 * The newest messages of a subagent the phone asks for (`subagentPageSize`,
 * spec 2026-10-05-mobile-next § 3); older ones are counted in `droppedCount`.
 * Kept at `TRANSCRIPT_PAGE_SIZE` for the same reason: one page must fit one
 * relay frame.
 */
export const PHONE_SUBAGENT_PAGE = TRANSCRIPT_PAGE_SIZE
