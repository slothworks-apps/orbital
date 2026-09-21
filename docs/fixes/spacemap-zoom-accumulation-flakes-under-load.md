---
id: spacemap-zoom-accumulation-flakes-under-load
title: The spacemap zoom accumulation test flakes under full-suite load
type: fix
status: backlog
domain: web
tags:
  - tests
  - flake
  - spacemap
---
# The spacemap zoom accumulation test flakes under full-suite load

Seen once, during the desktop packaging work, on a full `npm test` run that
touched no web code:

```
FAIL  src/test/spacemap.test.tsx > SpaceMap zoom buttons >
      accumulates presses made during a run, and stops at the end of the range
AssertionError: expected 21 to be 20
```

It did not reproduce. `spacemap.test.tsx` alone passed three times out of
three, and the next full run was green across all 1583 tests.

## What it looks like

The assertion counts zoom steps accumulated while a run is in progress, so it
depends on how many timer or animation-frame ticks elapse between the presses
and the read. One extra tick makes 20 into 21. Under a full suite the machine
is contending for CPU with every other test file, which is exactly the
condition that stretches a frame — and it is the only condition under which the
failure has been observed.

So the most likely cause is the test, not the component: a timing-sensitive
assertion against a value that real frame scheduling is allowed to reach one
step early. Anyone fixing it should look first at whether the test can drive
the clock deterministically instead of counting on elapsed ticks, before
suspecting the accumulation logic itself.

## Why it is written down and not fixed

One sighting is not enough to tell a flaky assertion from a real off-by-one
that only load exposes, and the work it appeared during was packaging, nowhere
near this code. Recorded so the second sighting starts from here rather than
from a fresh diagnosis — and so that "it passed on re-run" is not quietly
accepted a second time.
