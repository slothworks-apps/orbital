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
  ...options
}: PopupPositionOptions & { anchor: Partial<DOMRect>; natural: number; width?: number }) {
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  usePopupPosition(true, anchorRef, popupRef, options)
  return (
    <>
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
