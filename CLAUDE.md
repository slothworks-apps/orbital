<!-- atlas:begin 2026-09-16 -->
## Documentation

Documentation lives in `docs/` and every markdown file there carries
atlas frontmatter. `docs/CLAUDE.md` is the full rule: the fields, the
types, the statuses and the directory each type lives in. Read it before you
write, move or rename a document.

### Writing documents is part of the work

Do not wait to be asked for one. When something below happens, write the
document in the same change, before you report the work as done.

| what just happened | write |
|---|---|
| you chose one way over another, or ruled one out | `adr` |
| you agreed how something should work before building it | `spec` |
| the work needs more than a few steps | `plan` |
| you worked out how a part of the product behaves today | `domain` |
| you found a bug you are not fixing now | `fix` |
| you worked out the steps to run or repair something | `runbook` |

An answer that lives only in the chat is gone when the session ends. Check
first whether the document already exists and update that one instead of
writing a second. When the work a document describes is finished, set its
status.

```bash
atlas validate    # run this before you commit
```
<!-- atlas:end -->

## Visual design

The design lives in Claude Design, not in this repository. Always read it
from there, through the `DesignSync` MCP:

```
projectId  df77470e-1384-436c-8b25-5e01acfc497f
canvas     https://claude.ai/design/p/df77470e-1384-436c-8b25-5e01acfc497f?file=Orbital.dc.html
```

`list_files` for the file list, `get_file` for one file. `Orbital.dc.html` is
the main canvas; artboards are `<div id="1a">`, `<div id="2b">` and so on, and
the id is how they are referred to in conversation ("section 2a"). The project
also holds `Planet Variants.dc.html` and several `Feature - *.dc.html`.

Two things that will otherwise waste your time:

- **Any export committed under `design/` is stale.** New artboards are added to
  the canvas and never re-exported. Do not read the local copy, do not answer a
  design question from it, and do not conclude an artboard does not exist
  because it is missing there.
- **Only the MCP works.** `WebFetch` on the canvas URL returns 403, and the
  Claude in Chrome extension is often not connected. If a `DesignSync` read
  fails on authorization, ask the user to run `/design-login`.

`get_file` returns a JSON envelope whose `content` is escaped; unescape `\n`
before reading it, and grep for the artboard id rather than paging the whole
file — the canvas is ~240 KB.
