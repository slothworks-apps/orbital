---
id: issue-duplicate-check-reads-without-tools
title: The duplicate check is one model call over a list, not an agent with tools
status: in-force
type: adr
domain: sessions
related:
  - 2026-10-20-report-to-github-design
  - ephemeral-title-queries
tags:
  - issues
  - gh
---
# The duplicate check is one model call over a list, not an agent with tools

## The problem

Before an issue goes to Orbital's GitHub, the user can ask Claude whether it
is already filed. The obvious build is a background agent with `gh` or a
fetch tool that searches the repository the way a person would.

## Decision

The server fetches the issues itself — `gh issue list --state all`, else the
public REST API — and hands the list and the draft to one `askOnce` call:
no tools, no transcript, one turn. The model answers with issue numbers and
a sentence each; numbers it was not shown are dropped.

## Why

- **The prompt is other people's text.** Every issue body in the list was
  written by whoever filed it, and the draft holds an error record. An agent
  with tools reading that is an agent a stranger can instruct; with no tools
  the worst a crafted issue can do is a wrong match, which the user sees
  before acting on it.
- **The recent issues fit one prompt.** The newest 40, each with the
  opening of its body, are read in one go; searching in steps buys nothing
  a single read does not.
- **It stays out of the map.** `askOnce` already runs without a transcript
  ([[ephemeral-title-queries]]); an agent loop would need the same care and
  more of it.

## Ruled out

- **An agent with `gh` as a tool** — the reasons above.
- **Running the check every time the review step opens** — a model call the
  user did not ask for; the word search already runs on its own and is free.
