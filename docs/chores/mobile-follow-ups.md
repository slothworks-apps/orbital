---
id: mobile-follow-ups
title: Mobile app — deferred follow-ups from the 2b reviews
type: chore
status: backlog
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - 2026-10-02-mobile-app-write
  - the-connected-phone-notifies-itself
tags:
  - mobile
  - capacitor
  - shared
---

# Mobile app — deferred follow-ups from the 2b reviews

Small findings the phase 2b task reviews surfaced and deliberately
deferred. None blocks anything; each names the file to open when it is
next touched.

- ~~**A refused relay secret on the WebSocket is not rate-limited**
  (`relay/src/ws.ts`): the pairing routes count a wrong secret against the
  IP's limit, the socket's `auth` does not, so a short secret could be
  guessed over days. The runbook asks for a long random one; a per-IP
  throttle of refused `auth` with the same `limited()` would close it.~~
  — fixed 2026-10-08: one `RateLimiter` (`relay/src/rateLimit.ts`) on the
  context; a refused secret counts against it, and a spent IP is closed
  with `CLOSE_RATE_LIMITED` (a code a device retries on) before the
  secret is looked at.
- **`Camera.getPhoto` is deprecated in `@capacitor/camera` 8.x**
  (`web/src/mobile/platform/photo.ts`). The plugin replaces it with
  `takePhoto` and `chooseFromGallery`, which return a `MediaResult` with
  `webPath` and run on its newer flow; `getPhoto` still routes to the
  legacy flow and works. Move over before the plugin's next major.
- **An image evicted from the URL cache blanks while mounted**
  (`web/src/mobile/transport/imageResolver.ts`). Past `IMAGE_URL_CACHE_MAX`
  the oldest blob URL is revoked, and a `useImageUrl` consumer still
  holding it is never told to re-resolve. The bound sits well above one
  screen of images, so it has not been seen; a transcript with more
  mounted images than the bound would show it.
- **The put timeout counts from the call, not from the last chunk**
  (`shared/src/remote/client.ts`, `putBlob`). Chunks are queued
  synchronously, so the re-arm after the last chunk lands in the same
  tick as the first arm; a large upload on a slow uplink could time out
  on the phone while the Mac still stores it. Photos are downscaled
  first, so the window is small. Keying the timer on `bufferedAmount`
  would make it honest.
- **A header the Mac refuses early still has every chunk queued**
  (`putBlob`): `too_large` and `busy` answer the header, but the chunks
  are already on the socket. Bandwidth only; the Mac drops orphan chunks.
- ~~**The notification permission is requested on every boot**
  (`web/src/mobile/platform/push.ts`): after one denial Android 13+ shows
  the system prompt once more on the next start. `checkPermissions()`
  first would ask once.~~ — fixed 2026-10-08: both plugins ask only from
  `prompt` (`mayAskForNotifications`); Android reports a first denial as
  `prompt-with-rationale`, so that state is not asked again either. The
  local notification checks first too, since its `schedule` asks on its own.
- **Tap listeners have no install guard** (`push.ts`,
  `installPushListeners`): a second `boot()` in a native dev reload would
  add duplicate listeners; `wireNotifications` has the guard, this does not.
- ~~**A failed `connect()` skips `registerPush()`** (`web/src/mobile/boot.ts`):
  an identity read that throws leaves the token unregistered for that
  boot; the next boot registers.~~ — fixed 2026-10-08: registered in a
  `finally`; `clientRef` keeps the token for the next client.
- ~~**The banner's title keys on the notifier's copy string**
  (`web/src/mobile/notify.ts`).~~ — **done**: `NEEDS_INPUT_BODY` is
  exported from `shared/src/notifications.ts` and the banner reads it.
- ~~**The phone's photo pick has no in-flight guard**
  (`web/src/mobile/screens/SessionComposer.tsx`): a second tap while the
  picker is open, or a result arriving after leaving the session, is not
  handled; the legacy camera flow keeps one saved call.~~ — fixed
  2026-10-08: a module-wide in-flight flag, and a result is dropped once
  the composer is unmounted or another session is open.
- ~~**A 200 MP shot asks the plugin for a full-resolution bitmap**
  (`platform/photo.ts`) and could hit the plugin's own out-of-memory error
  before the downscale runs; passing `width`/`height` to the plugin would
  avoid it at the cost of the true `original` size on the chip.~~ — fixed
  2026-10-08: the plugin is asked for `PHOTO_PLUGIN_EDGE` (twice the
  target: Android's legacy flow scales without filtering, our canvas pass
  smooths it), and the chip's `original` comes from the plugin's exif
  (`takenSize`). Android's legacy flow still decodes the full bitmap once
  before it scales; only `takePhoto`/`chooseFromGallery` (item above) can
  avoid that.
- **Per-project model memory misses a typed `~` path** (9d,
  `web/src/mobile/screens/NewSessionScreen.tsx`): the project row holds the
  expanded path, so a typed `~/foo` finds no `lastModel`; tapping a row
  works.
- **A pending card stays tappable while the Mac sleeps** (9b offline,
  `web/src/mobile/screens/SessionScreen.tsx`): the composer locks, but the
  permission/plan/question card from the last live page keeps its buttons,
  and a tap fails against a Mac that is not there. The card's offline form
  should read as the transcript does ("as of"), inert, until the Mac is back.
- **`default_permission_mode` is read with an unchecked cast** in
  `GET /api/sessions/defaults` (`server/src/api/routes.ts`), as the web
  dialog reads it; a settings row outside the `PermissionMode` union would
  pass through.
- **Notifications carry Capacitor's placeholder icon**: the manifest names
  no `com.google.firebase.messaging.default_notification_icon` and the local
  notifications no `smallIcon`, so both the FCM push and the local
  notification show the launcher icon, which is still Capacitor's default.
  Android wants a white-on-transparent small icon in `res/drawable`; it
  belongs with the app icon itself.
