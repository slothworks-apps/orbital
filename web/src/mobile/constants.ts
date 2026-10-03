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
