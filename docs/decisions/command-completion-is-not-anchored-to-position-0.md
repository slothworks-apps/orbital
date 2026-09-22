---
id: command-completion-is-not-anchored-to-position-0
title: Command completion is not anchored to position 0, and matches inside the name
status: in-force
type: adr
domain: web
related:
  - 2026-09-20-composer-design
tags:
  - detail-panel
  - composer
---
# Command completion is not anchored to position 0, and matches inside the name

The composer shipped with two limits taken straight from the CLI's own
completion, both listed under canvas SCOPE in
[[2026-09-20-composer-design]] as things deliberately left out: the popup
opened on a `/` at position 0 only, and it filtered the catalog by prefix.

Both are now gone. `completionContext` offers a command wherever a `/`
starts a word, and `web/src/lib/commandMatch.ts` ranks matches instead of
requiring a prefix.

## Why the position rule went

The rule rested on an assumption that turned out to be wrong: that the CLI
expands a slash command only when the message opens with one, so completing
one mid-prompt would insert text that then just gets sent as text.

It does not. A probe command was placed in a throwaway `.claude/commands`
and sent twice through the bundled CLI — once as the whole prompt, once
inside a sentence (`prosim ted spust /zzqqprobe a nic jineho`). Both runs
came back with the token the command asks for, so the slug is picked up
later in the prompt as well. With that, refusing to complete it there was
withholding a completion for something that works.

The word-start test stays, and so does the rule that a run containing a
second `/` is a path: `and/or` and `ls /usr/bin` must not open a list.

## Why prefix matching went

A namespaced command is filed under its plugin (`superpowers:brainstorming`),
and the half that names it — the half a person remembers and types — is the
one after the colon. Under prefix matching that command is reachable only by
recalling which plugin it came from, which is precisely the thing the popup
exists to save you.

So `commandMatchRank` answers an order rather than a yes/no, in three bands:
a prefix of the whole name, a prefix of the segment after the colon, then a
substring anywhere. Ranking rather than merely widening the filter is what
keeps `/co` landing on `code-review` instead of burying it among everything
that happens to contain those two letters. Ties hold the catalog's own
order, so the list does not reshuffle as the fragment grows.

## What was ruled out

**Subsequence ("fuzzy") matching**, which the spec also lists as out of
scope, stays out. On a two-character fragment it matches most of a real
catalog, and the order it comes back in is then a scoring heuristic — the
list stops being something you can predict, which costs more than the
`crv` → `code-review` shortcut buys.

**Moving an accepted command to the front of the prompt** so it is certain
to run. Unnecessary once the probe showed mid-prompt slugs are picked up,
and it would have rewritten the user's text under their hands.

## The tint moved with it

Canvas 9e MID-LINE paints a mid-sentence `/code-review` as prose. That
rule rests on the same wrong assumption, and leaving it would have meant
a popup that offers a command, accepts it, and then renders it as plain
text — so `tokenizeComposer` now marks a command run wherever a `/` starts
a word, and `rehypeSentTokens` does the same in the transcript, where the
tint is supposed to be the receipt of what was typed.

**The canvas stays as it is** — Tomin's call, on the grounds that what the
app does is what matters here. So this is a place where the code and the
canvas knowingly disagree: for what a mid-sentence slug does, read this
document, not artboard 9e.

Two guards keep that from tinting prose. A `/` inside a word is a
separator (`either/or`, `web/src`), and a run carrying a second `/` is a
path (`/Users/tomin/notes.md`) — the second one is new, because a slug
regex stops at the slash and would otherwise have tinted `/Users`.

The transcript has no catalog to check a slug against and tints anything
slug-shaped, so widening its reach means it now also tints a bare `/etc`
in prose. That is the existing trade in this file taken more often, and
the same way round: failing to tint a turn that genuinely was a command
is the worse of the two errors.

## What kept the position rule

The `no command … — sends as typed` note, from `unknownCommand`. It warns
that a message meant as a command will go out as prose, which is only
true of a message that opens with one. A stray `/etc` mid-sentence was
never meant as a command, and a note about it would fire on ordinary
typing.
