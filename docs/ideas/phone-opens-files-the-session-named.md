---
id: phone-opens-files-the-session-named
title: The phone should open files the session named
status: done
type: idea
domain: mobile
related:
  - 2026-10-03-api-token-and-named-files-design
  - 2026-09-30-mobile-remote-design
  - 2026-10-05-mobile-next-design
tags:
  - security
  - file-viewer
---
# The phone should open files the session named

On the phone, a file path in the transcript opens nothing. The relay
refuses `/api/files` and `/api/files/image`, which the mobile remote spec
did deliberately: a path in a query is the kind of input the allowlist
exists to keep out. That made sense while the viewer's sandbox was the only
limit. The most useful case is also the one it blocks: an agent saves a
screenshot to `/tmp` and you want to look at it while away from the desk.

Spec `2026-10-03-api-token-and-named-files-design` limits outside-cwd reads
to paths the session's transcript names. The same rule would bound what a
phone could read, so the phone no longer has to be shut out entirely.

## What it takes

- **Allowlist.** Let `GET /api/files` and `GET /api/files/image` through
  with exactly two query parameters, `session` and `path`. Today the
  allowlist reasons only about path segments. The query needs its own
  canonical-form check, written with the same care as the segment check
  (one parameter of each name, no duplicates).
- **Bytes.** `inject` returns the body as a string, so an image cannot ride
  the `http` frame. It goes down the binary `blob` frames the relay already
  uses for transcript images, read through `resolveForSession` instead of
  the image store.
- **Client.** The phone's file viewer and lightbox. The text preview fits
  the `http` frame as it is.

## Built

Built in [[2026-10-05-mobile-next-design]] § 2, differently from the
sketch above: the routes stay off the allowlist, and the phone reads a file
over a sealed `file_get` message the Mac answers in blob frames, confined by
`resolveForSession` exactly as the desktop viewer is. Text previews ride the
same message, since a 512 KB text does not fit one `http` frame.
