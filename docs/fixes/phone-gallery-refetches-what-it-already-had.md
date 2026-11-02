---
id: phone-gallery-refetches-what-it-already-had
title: The phone's gallery fetches again what it already had
status: backlog
type: fix
domain: mobile
related:
  - an-open-gallery-rereads-the-whole-session-on-every-message
  - phone-images-load-under-a-moon
tags:
  - images
  - performance
---
# The phone's gallery fetches again what it already had

Found while making agent files reach the phone as thumbnails (`file_get`
with `edge`). That was the largest cost; these are what is left, by
expected impact. None is measured yet.

## What happens

- **A path is always asked of the Mac first.** `readPath`
  (`web/src/mobile/files/fileResolver.ts`) reads the cache only when the Mac
  is offline or answers 404, so every cold open of the gallery fetches every
  agent file's tile again, thumbnail or not.
- **Thumbnails of stored images never reach the disk cache.**
  `makeImageResolver` keeps only full images, since a thumbnail's bytes cannot
  be checked against its ref. Every cold start fetches every tile again.
- **The file cache runs one operation at a time and rewrites its index on
  every hit.** `FileCache.get` saves the index; each put base64-encodes the
  whole blob on the main thread (`platform/cacheDir.ts`, `platform/base64.ts`).
- **No limit on parallel fetches.** Each mounted tile starts its own
  `getBlob`/`getFile`; many large answers share one relay link, so the first
  tiles arrive late.

## Possible fixes

- Show a tile from the cache, then revalidate (as the file viewer does with
  `readCopy` and `revalidated`).
- Keep thumbnails on disk under their own key, trusting the device the phone
  is paired with.
- Save the cache index on a timer, not on every `get`.
- A small queue (about four) in front of the tunnel's blob fetches.
