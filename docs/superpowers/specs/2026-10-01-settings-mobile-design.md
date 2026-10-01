---
id: 2026-10-01-settings-mobile-design
title: Settings → Mobile — pairing a phone from the desktop
status: active
type: spec
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - 2026-10-01-mobile-remote-backend
  - remote-identity-is-ed25519-with-ephemeral-session-keys
  - 2026-09-21-settings-sections-design
  - why-orbital
tags:
  - mobile
  - relay
  - settings
  - web
---
# Settings → Mobile

**Status: active.** Brainstormed 2026-10-01, the first phase after
[[2026-10-01-mobile-remote-backend]] landed. The backend exposes everything
a phone needs; without this section nobody can pair the first phone.

Canvas: `Feature - Mobile.dc.html`, artboards **9m** (off), **9n** (on,
code and paired phones), **9o** (the confirmation dialog), **9q** (relay
status states) and **9r** (changing the relay with phones paired). Settings
chrome and nav come from `Orbital.dc.html` 1h and the existing
`web/src/panels/Settings.tsx`. The fidelity pass against the canvas is done
by the main session, not by the implementers.

## What it is for

The Mac is the only place a pairing can be approved
([[2026-09-30-mobile-remote-design]] § 1: confirmation on the Mac is
mandatory). This section is that place: it switches the remote on, shows
the code the phone scans, asks the user to compare the fingerprint, lists
the paired phones and lets the user remove one. Nothing about a phone's
notifications lives here — those are the phone's own.

## Decisions taken while brainstorming

- **Mobile is always in the nav**, between Appearance and Shortcuts as
  drawn, not behind the Experimental switch. The section is inert until
  the user turns it on, and off is the default.
- **Changing the relay URL with phones paired removes them.** The Mac
  connects to one relay; a phone paired through another relay cannot find
  it. The UI says so (9r), asks once, and revokes every phone before it
  saves the new URL. With no phone paired the URL just saves.
- **A code is never drawn on its own.** Not when the section opens, not
  when a code expires, not when the relay comes online after a change.
  Every code is a two-minute window in which a phone can ask to pair;
  only a click opens it. This deviates from 9r's note "a new code is
  drawn once the new relay is online": after a relay change the QR area
  shows the online state with "New code", as in 9n after an expiry.
- **The confirmation dialog belongs to the app, not to the Settings
  dialog.** A phone may scan within the two minutes after the user closed
  Settings; the request must still reach them. `pendingPair` in the
  store means the dialog is up, wherever the user is.
- **No polling.** The server already publishes every change on the hub
  topic `remote`; the web subscribes once for the app's lifetime and
  fetches `GET /api/remote` on every socket open to resync.

## 1. State

The store (`web/src/store/store.ts`) gains `remote: RemoteStatus | null`
and `applyRemoteEvent(msg)`. `RemoteStatus` is the server's type from
`server/src/remote/service.ts`, declared again in `web/src/lib/types.ts`
the way the other shared shapes are. `null` means "not fetched yet";
nothing renders a pairing state from `null`.

- `App.tsx` subscribes to `remote` for its whole lifetime, next to
  `sessions` and `errors`. A `status` event replaces the whole object. A
  `pair_request` event carries the same fields as `status.pendingPair`
  and is followed by a `status` publish on the server side, so the web
  may ignore it and read `pendingPair` from the status alone.
- On every socket `open` (first connect and each reconnect) the app
  fetches `GET /api/remote` and stores it. A reconnect can have missed a
  `pair_request` or a device change.
- `api.ts` gains `getRemote()`, `startPairing()`, `confirmPairing(accept,
  phone)`, `removeDevice(id)` and `restartRemote()`. `confirmPairing`
  does not throw on the contract's refusals: it returns `{ ok: true }`,
  `{ error: 'no_pending' }` (404), `{ error: 'mismatch' }` (409) or
  `{ error: 'relay_error' }` (502), and throws `ApiError` only outside
  the contract, the way `uploadImage` and `readFile` already do.

## 2. Server additions

Two small changes in `server/`; everything else exists.

- **`relayAttempts` in `RemoteStatus`:** the relay client's consecutive
  failed connection attempts (`RelayClient.attempt`, reset to 0 by `ok`).
  The status line needs it to tell "still connecting" from "cannot
  reach". The client's close handler must raise a `status` event when the
  counter changes even though the status stays `connecting`, so the hub
  gets a fresh publish; today `setStatus` deduplicates and a second
  failure is silent.
- **`POST /api/remote/restart`** calls `remote.settingsChanged()` (stop,
  then start with the same settings) and answers the new status. It is
  what "Try again" does in 9q, and it closes the gap recorded in
  [[2026-09-30-mobile-remote-design]] § 8, "a failed start does not retry
  on identical settings". Not allowlisted for phones, like every
  `/api/remote` route.

## 3. The section (9m, 9n)

A new file `web/src/panels/MobileSection.tsx`, rendered by `Settings.tsx`
for `section === 'mobile'` the way Harness templates and Shortcuts are.
`NAV_ITEMS` gets `{ key: 'mobile', label: 'Mobile' }` after `appearance`.

**PHONE ACCESS.**
- The switch "Let a phone connect through a relay" PATCHes
  `remote_enabled` through the dialog's `patchAndSet`. The server restarts
  the remote on the change ([[2026-10-01-mobile-remote-backend]]), so the
  status line moves on its own.
- **Mac name.** The input's value is `settings.remote_mac_name`; while it
  is empty the placeholder is `remote.macName` (the network name the
  server resolved). Debounced like the other text fields
  (`DEBOUNCE_MS`). Saving an empty string means "use the network name".
  The caption says it is set here only and the phone cannot rename it.
- **Status line** (9q), only while the switch is on, one mono line with a
  7 px dot that never blinks. Derived by a pure function from the status:
  - `relay === 'connecting'` and `relayAttempts < 2` → dim dot,
    "connecting to relay…";
  - `relay === 'online'` → accent dot, "online · " plus the relay URL's
    hostname;
  - `relay === 'connecting'` and `relayAttempts >= 2` → amber dot,
    "can't reach the relay";
  - `error !== null` → amber dot, "couldn't start", and the server's
    reason verbatim in a second mono line underneath.
  The threshold of two means the first retry still reads as connecting:
  one dropped socket that comes straight back must not flash a failure.

**PAIRING CODE** (9n, 9q). What the QR area shows follows the status
line:
- connecting → "Waiting for the relay", nothing else;
- can't reach / couldn't start → "The relay didn't answer. Check the URL
  under Advanced, or try again." and one secondary "Try again" that calls
  `POST /api/remote/restart`;
- online, no code → the "New code" button;
- online, code open (`remote.pairing` set) → the QR on a light tile,
  about 200 px, "Scan this with Orbital on your phone", the sentence
  naming the Mac as the phone will see it, "expires in m:ss" with the
  draining bar, counted from `pairing.expiresAt` with `useNow`;
- online, code expired (the status stops carrying `pairing`) → "CODE
  EXPIRED" with "New code". The server clears an expired code itself on
  its next `status()`; the web treats `expiresAt <= now` the same way so
  the label does not wait for the next publish.

"New code" calls `POST /api/remote/pair`; the answer's `qr` text is
rendered with `qrcode-generator` (no dependencies, synchronous SVG). The
QR text is the server's `QrPayload` JSON; the web never parses it. A 409
`offline` or `disabled` answer means the status changed under the user;
the section re-renders from the next status and shows nothing special.
Any other failure goes through `reportError`.

**PAIRED PHONES.** Header "PAIRED PHONES · N" with the caption
"NOTIFICATIONS ARE SET ON EACH PHONE". One row per device: name,
platform, "paired <date>", and "connected · now" when `online`, else
"last seen <relative>" from `lastSeenAt`, or nothing when it is null.
Remove opens an inline confirm in the row ("Remove <name>? It disconnects
now and has to pair again." — Cancel / Remove); Remove calls `DELETE
/api/remote/devices/:id`. A 404 is treated as done: the row is already
gone from the next status. Empty list: "No phones yet" with the hint to
scan the code above.

**ADVANCED** (9m, 9r). Folded by default, the fold's caption shows
"default" or "edited". The Relay URL input's value is
`settings.remote_relay_url`, placeholder is the default URL; "Reset to
default" saves an empty string. The URL is committed on Enter or blur,
not debounced: a relay change drops every phone session, so it must not
fire mid-typing. Under the field the caption from 9m about paired phones.
On commit:
- value unchanged → nothing;
- no phones paired → PATCH `remote_relay_url`;
- phones paired → the 9r dialog "Change the relay?" with the count and
  "Cancel" / "Change and remove". Confirm deletes every device first
  (sequentially, so each revoke still reaches the old relay while the Mac
  is connected to it), then PATCHes the URL. Cancel puts the saved value
  back into the field.

The web does not validate the URL beyond trimming: the server reports an
unparseable one through `error`, and the status line shows it (9q D).

## 4. The confirmation dialog (9o)

`web/src/panels/PairConfirmDialog.tsx`, mounted in `App.tsx` next to the
other app-level dialogs, open whenever `remote?.pendingPair` is set. Built
on `ui/Dialog` (size `sm`), eyebrow "PAIRING REQUEST · EXPIRES IN m:ss"
from `remote.pairing.expiresAt`, title "A phone wants to pair", the
phone's name and platform, the six characters in large mono boxes grouped
3 + 3 — the same boxes as 9e on the phone, so the comparison is box by
box — and the line "Confirm only if your phone shows the same code".
Buttons Reject and Confirm.

- Confirm → `confirmPairing(true, pendingPair.phone)`; Reject, Esc and a
  click on the scrim → `confirmPairing(false, pendingPair.phone)`. The
  `phone` sent is the one the dialog shows; the server refuses a
  mismatch, which is the point of sending it.
- `{ ok }` → the dialog closes with the next status (the server clears
  `pendingPair`); an info toast "Paired with <name>" or "Request
  rejected".
- `no_pending` → close; the request is gone (expired or already answered
  from another window).
- `mismatch` → stay open; the next status carries the request the server
  actually holds and the dialog re-renders from it. (The server only
  ever holds one pending request per code, so this is a race between two
  Orbital windows, not two phones.)
- `relay_error` → stay open, the message "The relay didn't answer. Try
  again." under the buttons; both buttons stay live.
- While `pendingPair` is set and the code expires, the server clears
  both on its next `status()`; the dialog closes with that status. The
  web does not close it on its own clock, because an answer that reaches
  the server a second after expiry is refused anyway (`no_pending`).

There is no "always allow" and no auto-accept; the dialog has no timer
that accepts.

## 5. What is deliberately not here

- Notification settings per phone: the phone's own, edited there
  ([[2026-09-30-mobile-remote-design]] § 5).
- Renaming a phone, or showing its fingerprint after pairing.
- The desktop version does not change for this spec; it is asked about
  when the work is done, as with every change under `web/` or `server/`.

## 6. Testing

Worth a test (pure logic with branches):
- the status-line derivation (off / connecting / online / unreachable /
  failed, and the attempt threshold);
- the countdown label from `expiresAt` and `now`, including "expired";
- the relay-URL commit decision (unchanged / save / ask-then-remove);
- `confirmPairing`'s mapping of 404 / 409 / 502 to the contract values;
- server: `relayAttempts` in the status and a `status` publish on the
  second failure; the restart route.

Not tested: that the section renders its rows, the QR's pixels, the
dialog's styling.
