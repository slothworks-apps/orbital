---
id: file-viewer-owns-a-second-language-table
title: The file viewer owns a second extension-to-language table
type: chore
status: backlog
domain: web
related:
  - one-syntax-palette-for-all-code
  - 2026-09-23-edit-diffs-in-the-transcript
  - 2026-09-19-file-viewer-design
tags:
  - transcript
  - file-viewer
---
# The file viewer owns a second extension-to-language table

`web/src/lib/highlight.ts` exports `languageFromPath`, which maps a file
path to a shiki language id and a label. `web/src/panels/FileViewer.tsx`
still carries its own `LANGUAGE_BY_EXTENSION`, `extensionOf` and
`languageFor` — the same table, by value, and the original of it.

The duplicate exists because the diff work that needed the table could not
edit `FileViewer.tsx`: another agent was changing that file in the same
stretch of work, and the two edits would have collided over nothing. So the
table was lifted into `lib/highlight.ts` beside `tokenizeCode`, which is
where it belonged anyway, and the viewer's copy was left where it was.

## The job

Delete `LANGUAGE_BY_EXTENSION`, `extensionOf` and `languageFor` from
`panels/FileViewer.tsx` and call `languageFromPath` from
`lib/highlight.ts` instead. The viewer uses both fields — `.lang` for
`tokenizeCode` and `.label` for the meta line — and the exported function
returns both, so the call sites need no other change.

Until then: **a new extension has to be added in two places**, and adding it
in only one is silent. That is the whole cost, and it is the reason this is
written down rather than left to be noticed.
