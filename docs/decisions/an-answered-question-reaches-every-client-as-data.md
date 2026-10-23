---
id: an-answered-question-reaches-every-client-as-data
title: An answered question reaches every client as data, with the CLI's prose as the fallback
status: in-force
type: adr
domain: sessions
tags:
  - server
  - web
  - phone
---
# An answered question reaches every client as data, with the CLI's prose as the fallback

## The problem

A question card showed its answers from two places: the answers this client
sent itself, and the `tool_result` the CLI wrote back. The card read that
result as a JSON `{answers}` envelope, but the CLI writes prose for the model:
`Your questions have been answered: "Q"="A". You can now continue…` (or
`The user answered: …`). So only the device that answered showed the card
answered. The Mac, after an answer from the phone, and every client after a
reload showed it unanswered (issue #121).

## The decision

Three sources, read in this order:

1. **`decision_resolved` carries the answers.** When a question is settled
   with answers, the server sends them on the event every client of the
   session already receives. The card turns answered on every device at
   once, before the result is written. A client never replaces answers it
   sent itself with these.
2. **The `tool_result` carries `answers`.** The CLI records the answers
   beside the prose, in the transcript entry's `toolUseResult` and the SDK
   frame's `tool_use_result`. The server reads them on both paths and puts
   them on the message. This is what a reload, a client that was offline,
   and a question answered in a terminal rely on.
3. **The prose is parsed** against the question texts the card already
   knows, for a result from a Mac that does not send `answers` yet. The
   phone updates first, so it meets such Macs.

## What was ruled out

- **Only the event.** It reaches only the clients connected at that moment,
  and a question answered in a terminal produces no event at all. The
  transcript has to be read regardless.
- **Only the prose.** It is written for the model, and its wording has
  already changed once. Questions and answers are not escaped inside it. It
  works as a fallback but not as the source.

`toolUseResult` is also an undocumented CLI format. It is structured and
keyed by question, so it breaks less easily than the prose, and the prose
remains behind it.
