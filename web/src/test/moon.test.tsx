import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MoonControl, moonInteraction } from '../map/Moon'
import type { Subagent } from '../lib/types'

// ---------------------------------------------------------------------------
// task 9 (spec § 5 "Two ways in", canvas 11e). `Moon` itself cannot be
// rendered under jsdom — there is no WebGL context for R3F's `<Canvas>` to
// reach the frame that would mount anything under it, `<Html>` included, so
// no `<Html>`-portalled content from ANY component in this map (`Planet`'s
// `CompactBadge`, `Hole`'s label, this file's own `MoonControl`) has ever
// been reachable through `render()` + `screen` in this repo's test suite.
// Confirmed empirically while building this task — see
// docs/decisions/moon-button-is-a-plain-dom-child-for-testability.md.
//
// So this file tests the two pieces task 9 pulled out of `Moon` specifically
// so they COULD be tested this way:
//
// - `moonInteraction`, the pure openable/inert/effectiveState gating
//   decision `Moon` would otherwise make inline;
// - `MoonControl`, the moon's interactive DOM layer, rendered bare (no
//   `<Canvas>`, no `<Html>` — it is store-free and three-free by design).
// ---------------------------------------------------------------------------

function makeSubagent(overrides: Partial<Subagent> = {}): Subagent {
  return { id: 'agent-1', name: 'Run the eslint and jest suites', state: 'working', startedAt: 0, ...overrides }
}

describe('moonInteraction', () => {
  it('is openable when wired and the subagent carries a toolUseId', () => {
    const result = moonInteraction(makeSubagent({ toolUseId: 'tool-1' }), true)
    expect(result).toEqual({ openable: true, inert: false, effectiveState: 'working' })
  })

  it('is inert — and pinned to the ended visual, regardless of the real state — when wired but toolUseId is missing', () => {
    // The trap the task brief names explicitly: a moon with no `toolUseId`
    // reads as INERT even while genuinely `working`, and its geometry must
    // follow — "keeps its motion still", not just "looks flatter".
    const result = moonInteraction(makeSubagent({ toolUseId: undefined, state: 'working' }), true)
    expect(result).toEqual({ openable: false, inert: true, effectiveState: 'ended' })
  })

  it('is neither openable nor inert when the caller never wired interactivity at all', () => {
    // The sandbox and most fixtures carry no `toolUseId` and never will —
    // `wired: false` must render them exactly as before this task, not as
    // INERT.
    const result = moonInteraction(makeSubagent({ toolUseId: undefined, state: 'idle' }), false)
    expect(result).toEqual({ openable: false, inert: false, effectiveState: 'idle' })
  })

  it('an ended agent with a toolUseId stays openable — its record outlives it', () => {
    const result = moonInteraction(makeSubagent({ toolUseId: 'tool-1', state: 'ended' }), true)
    expect(result).toEqual({ openable: true, inert: false, effectiveState: 'ended' })
  })
})

describe('MoonControl', () => {
  it('renders a real, always-tabbable button naming the task', () => {
    render(<MoonControl subagent={makeSubagent()} active={false} discPx={13} onOpen={vi.fn()} />)
    const button = screen.getByRole('button', { name: /Run the eslint and jest suites/ })
    expect(button.tagName).toBe('BUTTON')
    expect(button).not.toHaveAttribute('tabindex', '-1')
  })

  it('clicking calls onOpen', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<MoonControl subagent={makeSubagent()} active={false} discPx={13} onOpen={onOpen} />)

    await user.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('↵ on a focused moon opens it — the native button contract, no key handler needed', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(<MoonControl subagent={makeSubagent()} active={false} discPx={13} onOpen={onOpen} />)

    await user.tab()
    expect(screen.getByRole('button')).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('renders no hover decoration (halo/label) at rest — "openable moons get no resting decoration"', () => {
    render(<MoonControl subagent={makeSubagent()} active={false} discPx={13} onOpen={vi.fn()} />)
    expect(document.querySelector('[data-moon-halo]')).not.toBeInTheDocument()
    expect(document.querySelector('[data-moon-label]')).not.toBeInTheDocument()
  })

  it('hover renders the halo ring and the task label, and mirrors the change out', async () => {
    const user = userEvent.setup()
    const onHoverChange = vi.fn()
    render(
      <MoonControl
        subagent={makeSubagent()}
        active={false}
        discPx={13}
        onOpen={vi.fn()}
        onHoverChange={onHoverChange}
      />
    )

    await user.hover(screen.getByRole('button'))
    expect(document.querySelector('[data-moon-halo]')).toBeInTheDocument()
    expect(screen.getByText('Run the eslint and jest suites')).toBeInTheDocument()
    expect(onHoverChange).toHaveBeenCalledWith(true)

    await user.unhover(screen.getByRole('button'))
    expect(document.querySelector('[data-moon-halo]')).not.toBeInTheDocument()
    expect(onHoverChange).toHaveBeenCalledWith(false)
  })

  it('renders the active treatment — corner brackets, accent ring and tether — only when active', () => {
    const { rerender } = render(
      <MoonControl subagent={makeSubagent()} active={false} discPx={13} onOpen={vi.fn()} />
    )
    expect(document.querySelectorAll('[data-moon-bracket]')).toHaveLength(0)
    expect(document.querySelector('[data-moon-active-ring]')).not.toBeInTheDocument()
    expect(document.querySelector('[data-moon-tether]')).not.toBeInTheDocument()

    rerender(<MoonControl subagent={makeSubagent()} active discPx={13} onOpen={vi.fn()} />)
    expect(document.querySelectorAll('[data-moon-bracket]')).toHaveLength(4)
    expect(document.querySelector('[data-moon-active-ring]')).toBeInTheDocument()
    expect(document.querySelector('[data-moon-tether]')).toBeInTheDocument()
  })
})

/**
 * I5. The affordance is quoted in DESIGN px and drawn in CSS px, and the two
 * are not the same number at any zoom the map actually uses.
 *
 * `<Html>` renders its children at real CSS px, unaffected by any world
 * scale; the moon they decorate is world geometry whose on-screen radius is
 * `designPx * bodyZoomFactor(zoom) * bodyScale * zoom / 100`. The
 * counter-zoom is clamped to 1 from below, so it slows the shrink on the way
 * out and does nothing at all on the way in — it does NOT hold apparent
 * screen size constant, which is what the fixed-px version assumed. Across
 * the map's 5–400 range the factor spans ~0.17 to 4.0.
 *
 * These assert the relationship rather than the pixel values, so they cannot
 * fail merely because a canvas number was retuned — only because the
 * affordance stopped tracking the disc.
 */
describe('MoonControl scales with the camera (I5)', () => {
  const ringR = (sel: string) => {
    const el = document.querySelector(sel) as HTMLElement
    return parseFloat(el.style.width) / 2
  }

  it('halves every radius when the camera halves the body', () => {
    const { rerender } = render(
      <MoonControl subagent={makeSubagent()} active discPx={13} scale={1} onOpen={vi.fn()} />
    )
    const fullRing = ringR('[data-moon-active-ring]')

    rerender(
      <MoonControl subagent={makeSubagent()} active discPx={13} scale={0.5} onOpen={vi.fn()} />
    )
    expect(ringR('[data-moon-active-ring]')).toBeCloseTo(fullRing / 2, 6)
  })

  it('keeps the active ring OUTSIDE the disc at a zoomed-in scale', () => {
    // The bug in the other direction: at zoom 400 a working moon draws ~44
    // CSS px across while the ring stayed pinned at 13 px out from a
    // design-px radius, i.e. inside the disc it was supposed to circle.
    render(<MoonControl subagent={makeSubagent()} active discPx={13} scale={4} onOpen={vi.fn()} />)
    expect(ringR('[data-moon-active-ring]')).toBeGreaterThan(13 * 4)
  })

  it('floors the hit area rather than shrinking it past a pointer', () => {
    // At the bottom of the range the scale is ~0.17: a scaled 40 design-px
    // target would be 7 CSS px. The floor keeps it pressable; what it must
    // never do is go back to a fixed 40 px, which at that zoom surrounds a
    // 4 px dot and eats the map's own drag.
    render(<MoonControl subagent={makeSubagent()} active={false} discPx={13} scale={0.17} onOpen={vi.fn()} />)
    const button = screen.getByRole('button')
    const size = parseFloat(button.style.width)
    expect(size).toBeGreaterThan(7)
    expect(size).toBeLessThan(40)
  })

  it('grows the hit area past the floor once the moon is big enough to deserve it', () => {
    render(<MoonControl subagent={makeSubagent()} active={false} discPx={13} scale={4} onOpen={vi.fn()} />)
    expect(parseFloat(screen.getByRole('button').style.width)).toBeCloseTo(160, 6)
  })

  it('defaults to design px, so a bare render still draws the canvas geometry', () => {
    render(<MoonControl subagent={makeSubagent()} active={false} discPx={13} onOpen={vi.fn()} />)
    expect(parseFloat(screen.getByRole('button').style.width)).toBe(40)
  })
})
