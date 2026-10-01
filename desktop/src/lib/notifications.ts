/**
 * The rules live in `@orbital/shared/notifications` now, because the Mac's
 * remote module applies the same fold to decide `wake` frames for a phone
 * (spec 2026-09-30-mobile-remote-design § 5). Nothing in the desktop changes.
 */
export * from '@orbital/shared/notifications';
