---
id: show-images-pasted-into-terminal-sessions
title: Show images pasted into terminal sessions from their cache path
type: idea
status: backlog
domain: transcripts
related:
  - what-the-transcript-parser-skips
  - 2026-09-18-transcript-images-design
  - images-in-the-transcript-and-composer
tags:
  - transcripts
  - images
---
# Show images pasted into terminal sessions from their cache path

When you paste an image into the CLI, it writes an `isMeta` user entry,
`[Image: source: /Users/…/.claude/image-cache/<uuid>/1.png]`, next to your
turn. The parser now drops `isMeta` entries (see
`what-the-transcript-parser-skips`), so the path is no longer shown
anywhere. The idea was to read the image from that path and show it in the
transcript.

**Checked on 2026-09-23, before anyone builds this:** the idea may not be
needed. In every pasted-image prompt surveyed (26 of them), the human's own
entry, the one with the same `promptId`, already carries the pixels as a
base64 `image` block. `entriesToMessages` puts that block into the
content-addressed store (`server/src/images/store.ts`, spec
`2026-09-18-transcript-images-design`) and renders it. The cache directory
also does not last: `~/.claude/image-cache` did not exist on this machine
when the survey ran, so a path read later would usually point at nothing.

Pick this up only if a transcript turns up where the path note has no
`image` block next to it. That could be an older CLI, or a paste the CLI
chose not to inline. If that happens, the change belongs in
`entriesToMessages`. For an `isMeta` entry whose text matches
`[Image: source: <path>]`, read the file if it still exists and is under
`~/.claude/image-cache`, pass it through `ImageStore.putBytes`, and attach
the ref to the preceding user turn. Skip it when the ref is already there,
so that the same image is not shown twice.
