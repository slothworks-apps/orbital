---
id: clumps-pack-loosely-offset-not-in-a-grid
title: A tag's planets pack offset and unevenly spaced, not in a grid
type: adr
status: in-force
domain: web
related:
  - separation-rests-at-the-outline
  - 2026-09-18-tag-clusters-design
tags:
  - space-map
  - simulation
---
# A tag's planets pack offset and unevenly spaced, not in a grid

## Context

`packSlots` places each planet of a tag as close to the middle of its clump
as its box allows. A box is the planet with its label under it, so it is
wide and flat, and boxes packed that tightly meet face to face: two planets
stood exactly one above the other, larger clumps formed rows and columns.
The map read as a spreadsheet of planets, not as a sky.

That is not one person's taste. The map is a space map for everyone who
opens it: planets in a sky, and a grid fights that picture for anyone.
The grid also said nothing — no row or column meant anything — so its
order was noise the eye still tried to read. Nothing is lost by dropping
it: a planet's place never carried information. The cost is a one-time
reshuffle of each tag's planets on the first launch after the update;
from then on the packing is as stable as before. So it is the default,
with no setting: a setting would ask every user to choose between two
looks of the same automatic layout.

## Decision

Two rules loosen the packing. Both come from the session ids, so the same
clump always packs the same way and nothing jumps between renders:

- **Uneven air.** Each planet keeps up to `ORGANIC_AIR_PX` more from its
  tag-mates than `NEIGHBOUR_AIR_PX`, fixed by a hash of its id; a pair
  keeps the mean of its two.
- **Offset over square on.** A spot where the new box lines up with a
  neighbour across the face they share costs extra (`alignmentCost`), past
  half a box of overlap. So neighbours settle offset like bricks: a pair
  stands side by side at different heights, or one above the other
  shifted sideways.

Separation in the tick still keeps only `NEIGHBOUR_AIR_PX`, so the extra
air lives in the slots alone and the contact never fights it.

## Alternatives

- Random jitter on the slot after packing: a jitter that cannot overlap
  has to be packed anyway, and one that does not is undone by separation.
- Letting the user drag a planet to a place in its clump and remembering
  it: a new feature with storage per session, for what is a matter of how
  the automatic layout looks.

## Consequences

A clump is a little looser than before; the clump-shape tests allow for it
within their existing bounds. A planet's place depends on its id as well as
its size, so two clumps of the same sizes no longer look identical.
