---
id: a-hand-edited-diff-comes-back-as-the-tools-own-input
title: A hand-edited diff comes back as the tool's own input
status: in-force
type: adr
domain: sessions
related:
  - the-editor-is-a-second-route-to-one-verdict
  - 2026-09-23-ide-bridge-design
  - 2026-09-23-permission-and-plan-decisions-design
tags:
  - ide
  - runner
  - permissions
---
# A hand-edited diff comes back as the tool's own input

## The problem

`openDiff`'s accepted answer is `FILE_SAVED`, and its second content element
is **the file as the human left it** — which need not be what Orbital
proposed. The diff tab is editable, so "accept" and "accept after changing it"
arrive through the same door.

Orbital cannot write the file. Its only channel is the `canUseTool` verdict,
and the permission spec is explicit that an approval carries no `updatedInput`:
approving a tool must not rewrite what it was asked to do. So a hand-edit has
nowhere obvious to go, and each of the obvious answers is bad:

- **approve as proposed** — the human's edit is silently discarded, and the
  file ends up as the version they edited *away from*;
- **decline** — they pressed save; answering "no" is a lie about what they
  did.

## What was decided

**The hand-edit is expressed as the tool's own input, so the agent's tool
writes exactly what the human saved.**

The three diffable tools are chosen precisely because their input can say
this. `server/src/ide/edits.ts` holds both directions, pure:

| tool | proposed file | input that reproduces `saved` |
|---|---|---|
| `Write` | `input.content` | `{...input, content: saved}` |
| `Edit` | the patch applied | `{file_path, old_string: <whole original>, new_string: saved}` |
| `MultiEdit` | the patches applied in order | one edit, whole original → `saved` |

Collapsing a patch tool to a single whole-file replacement is unambiguous by
construction: the entire original occurs exactly once in itself, so
`replace_all` is not needed and cannot mis-fire.

The edit still lands in the transcript as the tool call it was, rather than as
bytes that appeared from nowhere — which is the second reason for doing it this
way rather than having Orbital write the file even if it could.

## The one thing that is not measured, and why it is safe anyway

Whether the extension writes the file itself when the human saves the diff tab
was **not** verified against a live editor. Both answers are safe, which is
what made it acceptable to land:

- if it did write, the rewritten `old_string` no longer matches what is on
  disk, the tool errors, and the file is **already** what the human saved;
- if it did not, the tool writes `saved`.

Either way the file ends up correct and the model reads an ordinary tool
result. It is still worth measuring — see *Still to verify* in the spec.

## What was ruled out

**Offering the diff for every tool and handling a hand-edit only where it
fits.** That leaves a branch with no good answer in it, for tools whose input
is not a file at all. Restricting the route to the three tools that can express
any file removes the branch rather than papering over it: there is no "some
other tool" case to get wrong.

**Treating an unexpressible hand-edit as an approval.** The code still has
that path — an `Edit` against an empty original — and it declines with a
message naming what happened, so the model re-reads the file and proposes
again. Silently approving the version the human edited away from would be the
one outcome nobody could have predicted from what they did.
