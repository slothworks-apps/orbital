---
id: labs-features-move-to-regular-settings
title: Every Labs feature moves to the regular settings, its switch off by default
status: in-force
type: adr
domain: settings
related:
  - why-orbital
  - 2026-10-29-colour-tokens-design
  - 2026-10-20-limit-suns-design
  - 2026-10-20-report-to-github-design
  - 2026-10-05-embedded-terminal-design
  - 2026-09-30-session-harness-design
tags:
  - web
  - settings
---

# Every Labs feature moves to the regular settings, its switch off by default

## Context

On 2026-10-29 Settings → Labs held five features: Harness, Terminal, Check
reports with Claude, Limit suns and Colour themes. The maintainer had used
each for long enough to know it holds up. `why-orbital` → Experimental,
Labs, and out says a feature leaves Labs by being promoted to the regular
settings or turned on by default, or by being removed; it does not stay
there for good.

## What was decided

All five are promoted to the regular settings, in the release of desktop
0.45.0. Each keeps its switch, and the switch stays **off** by default:
someone who had it on keeps it on, and nobody else notices a change.

| feature | where it lives now |
|---|---|
| Harness | its own section, **Harness** (was "Harness templates"), always listed: the switch on top, the templates below while it is on |
| Terminal | the **Terminal** section, always listed: the switch on top, placement and cursor below while it is on |
| Check reports with Claude | General → REPORTS |
| Limit suns | Appearance → MAP, after Show trash |
| Colour themes | Appearance → COLOURS, **with no switch**: a picker whose default, Deep Field, is today's palette needs no gate |

Labs stays in the code with no rows. The nav lists it only while it has a
key, so the next feature to try can go there without bringing the section
back by hand.

## Options ruled out

- **Turning the four switched features on for everyone.** Harness, Terminal,
  the report check (one model call) and the suns change what an existing
  user sees or spends; `why-orbital` asks that nothing change for them
  without their choice.
- **Keeping a switch for colour themes.** It would gate a picker whose
  default changes nothing.
