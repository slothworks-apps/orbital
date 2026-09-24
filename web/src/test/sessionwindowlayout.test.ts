import { describe, it, expect } from 'vitest'
import { answeredWidthReached, resolveWindowLayout } from '../lib/sessionWindowLayout'

// Subagent list spec § 4: pane at or above the pair minimum, swap below it,
// and a window main has promised to grow counts as already grown.
const THRESHOLD = 760

describe('resolveWindowLayout', () => {
  it('is a pane at the threshold and a swap one pixel under it', () => {
    expect(resolveWindowLayout({ windowWidth: THRESHOLD, thresholdPx: THRESHOLD })).toBe('pane')
    expect(resolveWindowLayout({ windowWidth: THRESHOLD - 1, thresholdPx: THRESHOLD })).toBe('swap')
  })

  it('is a pane from the first frame of a grow main has answered', () => {
    expect(
      resolveWindowLayout({ windowWidth: 500, answeredWidth: 880, thresholdPx: THRESHOLD }),
    ).toBe('pane')
  })

  it('is a swap when main answered a width that still does not clear the threshold', () => {
    expect(
      resolveWindowLayout({ windowWidth: 500, answeredWidth: 700, thresholdPx: THRESHOLD }),
    ).toBe('swap')
  })

  it('follows the window when it is wider than the answer', () => {
    expect(
      resolveWindowLayout({ windowWidth: 900, answeredWidth: 500, thresholdPx: THRESHOLD }),
    ).toBe('pane')
  })
})

describe('answeredWidthReached', () => {
  it('holds the answer while the window is still growing towards it', () => {
    expect(answeredWidthReached(600, 880)).toBe(false)
  })

  it('drops the answer once the window reaches it, or passes it', () => {
    expect(answeredWidthReached(880, 880)).toBe(true)
    expect(answeredWidthReached(900, 880)).toBe(true)
  })
})
