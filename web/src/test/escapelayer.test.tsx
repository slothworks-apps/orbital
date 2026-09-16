import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { EscapeBoundary, useEscapeLayer, escapeLayerDepth } from '../ui/escapeLayer'

function pressEscape() {
  // Dispatched on `document` so it propagates up to the capture-phase
  // listener on `window`, the way a real keystroke does.
  fireEvent.keyDown(document, { key: 'Escape' })
}

/**
 * The bug this guards against: every surface used to listen for Escape
 * itself, and `App` listened on `window` in the CAPTURE phase — which runs
 * outside-in, so it fired before any inner handler and no amount of
 * `stopPropagation` further in could head it off. One Escape inside an open
 * select, inside an open rule row, inside the Tags & rules panel closed all
 * three at once. Panel tests never caught it because they render a panel in
 * isolation, without App's listener present.
 */
describe('useEscapeLayer', () => {
  function Layer({
    active,
    onEscape,
    children,
  }: {
    active: boolean
    onEscape: () => void
    children?: React.ReactNode
  }) {
    useEscapeLayer(active, onEscape)
    // A surface that can contain further layers wraps its content, exactly as
    // App / Dialog / the panels do. Without this they'd all share one depth.
    return <EscapeBoundary>{children}</EscapeBoundary>
  }

  it('delivers Escape only to the innermost active layer', () => {
    const outer = vi.fn()
    const inner = vi.fn()
    render(
      <Layer active onEscape={outer}>
        <Layer active onEscape={inner} />
      </Layer>,
    )

    pressEscape()
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })

  it('falls back to the next layer out once the inner one deactivates', () => {
    const outer = vi.fn()
    const inner = vi.fn()

    function Harness() {
      const [innerOpen, setInnerOpen] = useState(true)
      return (
        <Layer active onEscape={outer}>
          <Layer active={innerOpen} onEscape={inner} />
          <button onClick={() => setInnerOpen(false)}>close inner</button>
        </Layer>
      )
    }
    render(<Harness />)

    pressEscape()
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('close inner'))
    pressEscape()
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).toHaveBeenCalledTimes(1)
  })

  /**
   * The ordering guarantee. React runs child effects BEFORE parent ones, so
   * mount order alone would put the outer surface on top — backwards. What
   * saves it is that a surface registers when it becomes ACTIVE, and inner
   * surfaces open later in response to a state change.
   */
  it('ranks by activation order, not mount order', () => {
    const panel = vi.fn()
    const popup = vi.fn()

    function Harness() {
      const [popupOpen, setPopupOpen] = useState(false)
      return (
        <Layer active onEscape={panel}>
          {/* Mounted from the start, but not active until opened. */}
          <Layer active={popupOpen} onEscape={popup} />
          <button onClick={() => setPopupOpen(true)}>open popup</button>
        </Layer>
      )
    }
    render(<Harness />)

    pressEscape()
    expect(panel).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('open popup'))
    pressEscape()
    expect(popup).toHaveBeenCalledTimes(1)
    expect(panel).toHaveBeenCalledTimes(1)
  })

  it('always calls the latest handler without re-ranking the layer', () => {
    const first = vi.fn()
    const second = vi.fn()
    const inner = vi.fn()

    function Harness() {
      const [swapped, setSwapped] = useState(false)
      return (
        <Layer active onEscape={swapped ? second : first}>
          <Layer active onEscape={inner} />
          <button onClick={() => setSwapped(true)}>swap</button>
        </Layer>
      )
    }
    render(<Harness />)

    // Changing the outer callback must not bump it above the inner layer.
    fireEvent.click(screen.getByText('swap'))
    pressEscape()
    expect(inner).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })

  it('unregisters on unmount, leaving no stale layers behind', () => {
    const before = escapeLayerDepth()
    const { unmount } = render(<Layer active onEscape={vi.fn()} />)
    expect(escapeLayerDepth()).toBe(before + 1)
    unmount()
    expect(escapeLayerDepth()).toBe(before)
  })

  it('does nothing when no layer is active', () => {
    const onEscape = vi.fn()
    render(<Layer active={false} onEscape={onEscape} />)
    pressEscape()
    expect(onEscape).not.toHaveBeenCalled()
  })
})
