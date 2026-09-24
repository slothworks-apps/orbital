---
id: subagent-model
title: Subagent model — the Settings row and the model label on moons
status: archived
type: idea
domain: sessions
related:
  - 2026-09-16-agent-model-design
tags:
  - models
  - space-map
---
# Subagent model — the Settings row and the model label on moons

> **Ruled out 2026-09-24** by Tomin. Which model a subagent runs on stays
> with the session: the developer tells the agent what to use for its
> subagents, and no Orbital setting overrides that. The label on a moon is
> not wanted either — the subagent panel already shows the agent's model,
> and that is enough. Kept for the notes on `CLAUDE_CODE_SUBAGENT_MODEL` and
> on what a `Task` block does and does not say about the model.

Artboard `4c` of `Feature - Agent model.dc.html` has a **Subagent model** row
("Model moons launch with unless the agent asks for a specific one":
Same as parent / Always Haiku / Always Sonnet), and `4a` shows a moon
carrying its own model name when it differs from the planet. Both were cut
from the agent-model spec to keep that change to the planet's model.

## What is buildable

The setting is. `query()` takes an `env` option, and the CLI reads
`CLAUDE_CODE_SUBAGENT_MODEL` — so `Runner.start()` can pass
`env: { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL: <value> }` and every
subagent the session spawns launches on that model. Like every other launch
option it would apply from the next session, never rewriting a running one.
The row's options should be built from the same catalog the planet picker
uses ("Same as parent" plus one entry per model), not the canvas's fixed
three.

## What is mostly not

A moon's actual model. `SubagentTracker` derives moons from `Task` tool_use
blocks in the transcript, and `input.model` is present only when the agent
explicitly asked for a model. So a label could be shown truthfully in exactly
two cases — the agent named a model, or Orbital itself forced one through the
env var above — and would have to stay absent otherwise. Which is in fact
what the canvas asks for ("only when it differs"), but it means the label is
missing most of the time rather than rare-but-informative.

Worth doing after the setting exists: with `CLAUDE_CODE_SUBAGENT_MODEL` set by
Orbital, every moon of that session has a known model, and the label starts
carrying real information.
