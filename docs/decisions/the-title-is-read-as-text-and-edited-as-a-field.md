---
id: the-title-is-read-as-text-and-edited-as-a-field
title: The title is read as text and edited as a field
status: in-force
type: adr
domain: ui
tags:
  - detail-panel
  - header
---

# The title is read as text and edited as a field

The detail header's title swaps element on edit: at rest it is a `<button>`
holding a two-line clamp, and only while it is being edited is there a
`<textarea>` in the DOM.

## Why

The canvas (`Feature - Detail header`, artboard 9e) asks for two things at
once: a field that grows from one line to two as the name needs it, and a
name longer than two lines that ends in an ellipsis. No single element does
both. A `<textarea>` cannot ellipsise — `text-overflow` does not apply to a
form control's value — so a clamped title would end mid-word with no sign
that anything was cut. A clamped block, conversely, is not typeable.

The alternative was to keep the always-mounted field and accept the hard cut.
It was rejected because the ellipsis is the only thing that tells the reader
the name continues, and the header's whole reason for this redesign is that
the title was being cut off.

## What it costs

Two elements to keep in step. The type is held once, in `TITLE_TYPE`, and
both render from it — a swap that moved the text by a pixel would read as a
jump. Focus and caret placement are now the panel's business: entering the
edit focuses the field and puts the caret at the end, because the usual edit
is fixing the tail.

It also changes how the title is addressed from a test: at rest it is
`getByRole('button', { name: <the title> })`, and the field appears after a
click.

## What came with it

Escape now belongs to the field while it is open (`useEscapeLayer`). Before,
Escape during a rename reached `App` and closed the whole panel, losing the
edit — tolerable for a one-line input, not for a field people will now write
two lines in. Escape restores the session's own name; a second press closes
the panel as always.
