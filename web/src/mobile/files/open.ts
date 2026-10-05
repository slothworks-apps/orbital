/**
 * Points the transcript's path and image presses at the phone's file screen
 * (spec 2026-10-05-mobile-next § 2): a press opens `openFile`, a long-press
 * copies the path. Boot calls it once. Stub — T2.1 fills it once the seam in
 * `web/src/lib/fileOpen.ts` exists; until then presses behave as on the
 * desktop.
 */
export function installFileOpen(): void {}
