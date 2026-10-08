---
id: the-relay-keeps-a-phones-record-after-unpairing
title: The relay keeps a phone's record after it is unpaired
type: fix
status: backlog
domain: relay
related:
  - 2026-10-08-landing-site-design
tags:
  - relay
  - privacy
---

# The relay keeps a phone's record after it is unpaired

## What happens

Unpairing removes the pair and nothing else, so the relay keeps personal data
it no longer needs, with no expiry:

- **A revoke on the Mac** deletes the row in `pairs` (`revokePair` in
  `relay/src/store.ts`). The phone's row in `devices` stays: display name
  (the phone model), platform, FCM push token, last seen.
- **"Pair a different Mac" on the phone** (`forgetEverything` in
  `web/src/mobile/forget.ts`) does not unpair on the relay at all. It sends an
  empty push token, best-effort, so the relay stops pushing; the pair and the
  device row stay.
- **Used pairing codes** are never pruned. `pruneExpiredTokens` deletes only
  `open`, `pending` and `rejected` tokens, so every `confirmed` row stays, and
  each keeps the name and platform of the phone that redeemed it.
- **A Mac** that stops using a relay leaves its device row, display name
  included, forever.

## Why it matters

The privacy policy drafted for the website (`site/content/privacy.md`) has to
say these records stay until the relay's operator deletes them. For the
relay SlothWorks runs, that makes every deletion a manual request.

## What a fix looks like

- A revoke deletes the phone's device row when it has no other pair.
- "Pair a different Mac" revokes the pair on the old relay before forgetting
  it, the way the Mac's revoke does.
- `pruneExpiredTokens` also removes confirmed tokens past their expiry: once
  the pair exists, the token carries nothing the pair does not.
- A device with no pair and no connection for a set period is deleted.

This touches the relay and the phone, and a phone already out there will
keep its old behaviour, so the relay must not depend on the new phone
behaviour to clean up.
