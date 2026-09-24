import { describe, it, expect } from 'vitest'
import { useRef } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { usePopupPosition, type PopupPositionOptions } from '../ui/usePopupPosition'

/**
 * jsdom has no layout, so both boxes are given their geometry by hand. The
 * viewport is jsdom's default 1024×768.
 */
function Harness({
  anchor,
  natural,
  width = 200,
  within,
  ...options
}: Omit<PopupPositionOptions, 'withinRef'> & {
  anchor: Partial<DOMRect>
  natural: number
  width?: number
  within?: Partial<DOMRect>
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const withinRef = useRef<HTMLDivElement | null>(null)
  usePopupPosition(true, anchorRef, popupRef, { ...options, withinRef: within ? withinRef : undefined })
  return (
    <>
      {within && (
        <div
          data-testid="within"
          ref={(el) => {
            withinRef.current = el
            if (el) el.getBoundingClientRect = () => within as DOMRect
          }}
        />
      )}
      <div
        data-testid="anchor"
        ref={(el) => {
          anchorRef.current = el
          if (el) el.getBoundingClientRect = () => anchor as DOMRect
        }}
      />
      <div
        data-testid="popup"
        ref={(el) => {
          popupRef.current = el
          if (el) {
            Object.defineProperty(el, 'offsetHeight', { value: natural, configurable: true })
            Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
          }
        }}
      />
    </>
  )
}

const popup = () => screen.getByTestId('popup')

/** A field sitting low on the screen — the detail panel's composer. */
const LOW = { left: 100, right: 300, top: 600, bottom: 620, width: 200, height: 20 }
/** A field sitting high on the screen — a dialog near the top. */
const HIGH = { left: 100, right: 300, top: 20, bottom: 40, width: 200, height: 20 }

describe('usePopupPosition', () => {
  it('opens below by default, one gap under the anchor (Select`s own placement)', () => {
    render(<Harness anchor={LOW} natural={100} gap={4} />)
    expect(popup().dataset.placement).toBe('below')
    expect(popup().style.top).toBe('624px')
  })

  it('flips above when the list does not fit below and there is more room above', () => {
    render(<Harness anchor={LOW} natural={400} gap={4} />)
    expect(popup().dataset.placement).toBe('above')
    // Sits its own height above the anchor, gap included.
    expect(popup().style.top).toBe(`${600 - 4 - 400}px`)
  })

  it('honours prefer: above — the composer opens over the panel floor (canvas 9b)', () => {
    render(<Harness anchor={LOW} natural={280} gap={8} prefer="above" />)
    expect(popup().dataset.placement).toBe('above')
    expect(popup().style.top).toBe(`${600 - 8 - 280}px`)
  })

  it('flips a prefer: above popup down when there is no room above it', () => {
    render(<Harness anchor={HIGH} natural={280} gap={8} prefer="above" />)
    expect(popup().dataset.placement).toBe('below')
    expect(popup().style.top).toBe('48px')
  })

  it('caps the height to the room on the chosen side', () => {
    render(<Harness anchor={HIGH} natural={900} gap={8} prefer="below" />)
    // 768 viewport − 40 anchor bottom − 8 gap − 8 margin.
    expect(popup().style.maxHeight).toBe('712px')
  })

  it('never squeezes below its minimum height, however tight the room', () => {
    render(<Harness anchor={{ ...HIGH, top: 0, bottom: 4 }} natural={900} gap={8} prefer="above" />)
    expect(parseFloat(popup().style.maxHeight)).toBeGreaterThanOrEqual(96)
  })

  it('matches the anchor width exactly when asked (canvas 9e: popup width = the well`s)', () => {
    render(<Harness anchor={LOW} natural={100} gap={8} matchAnchorWidth />)
    expect(popup().style.width).toBe('200px')
    expect(popup().style.left).toBe('100px')
  })

  it('treats minWidth as a floor over the anchor width, without setting a width', () => {
    render(<Harness anchor={LOW} natural={100} gap={4} minWidth={420} width={420} />)
    expect(popup().style.width).toBe('')
    expect(popup().style.minWidth).toBe('420px')
  })

  it('right-aligns to the anchor when asked', () => {
    render(<Harness anchor={LOW} natural={100} gap={4} align="right" width={250} />)
    // The anchor's right edge is 300, so a 250-wide popup starts at 50.
    expect(popup().style.left).toBe('50px')
  })

  it('keeps the popup inside the viewport margin', () => {
    render(
      <Harness
        anchor={{ left: 1000, right: 1020, top: 600, bottom: 620, width: 20, height: 20 }}
        natural={100}
        gap={4}
        width={300}
      />
    )
    // 1024 viewport − 300 width − 8 margin.
    expect(popup().style.left).toBe('716px')
  })

  it('re-measures on scroll and resize rather than closing', () => {
    render(<Harness anchor={LOW} natural={100} gap={4} />)
    const el = popup()
    el.style.top = '0px'
    fireEvent.scroll(window)
    expect(el.style.top).toBe('624px')
    el.style.top = '0px'
    fireEvent(window, new Event('resize'))
    expect(el.style.top).toBe('624px')
  })
})

/** The subagent chip on the detail header's state row, 120px in from the left. */
const CHIP = { left: 120, right: 210, top: 100, bottom: 122, width: 90, height: 22 }

describe('usePopupPosition withinRef', () => {
  it('hangs the popup off the anchor when the bounding element has room for it', () => {
    // A wide header (a detached window): the list stays under the chip that opened it.
    render(
      <Harness anchor={CHIP} natural={100} gap={8} width={372} within={{ left: 18, right: 1000, top: 100, bottom: 122 }} />,
    )
    expect(popup().style.left).toBe('120px')
  })

  it('slides the popup left so it ends on the bounding element`s right edge (canvas 25a)', () => {
    // The 450px main-window panel: 450 − 372 = 78, left of the chip.
    render(
      <Harness anchor={CHIP} natural={100} gap={8} width={372} within={{ left: 18, right: 450, top: 100, bottom: 122 }} />,
    )
    expect(popup().style.left).toBe('78px')
  })

  it('never starts left of the bounding element', () => {
    // A bound narrower than the popup: the popup starts on its left edge and overhangs on the right.
    render(
      <Harness anchor={CHIP} natural={100} gap={8} width={372} within={{ left: 60, right: 400, top: 100, bottom: 122 }} />,
    )
    expect(popup().style.left).toBe('60px')
  })
})
