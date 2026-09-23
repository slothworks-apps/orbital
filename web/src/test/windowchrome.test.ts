import { describe, expect, it } from 'vitest'
import {
  WINDOW_DRAG_BAND_PX,
  hasWindowBand,
  mapTopInset,
  windowButtonsChange,
} from '../lib/windowChrome'
import { SIDEBAR_COLLAPSE_MS } from '../ui/motion'

describe('hasWindowBand / mapTopInset', () => {
  it('draws the band, and fit keeps clear of it, only in a windowed desktop window', () => {
    expect(hasWindowBand({ desktop: true, fullScreen: false })).toBe(true)
    expect(mapTopInset({ desktop: true, fullScreen: false })).toBe(WINDOW_DRAG_BAND_PX)
  })

  it('has no band in full screen', () => {
    expect(hasWindowBand({ desktop: true, fullScreen: true })).toBe(false)
    expect(mapTopInset({ desktop: true, fullScreen: true })).toBe(0)
  })

  it('has no band in a browser, whatever full screen says', () => {
    for (const fullScreen of [false, true]) {
      expect(hasWindowBand({ desktop: false, fullScreen })).toBe(false)
      expect(mapTopInset({ desktop: false, fullScreen })).toBe(0)
    }
  })
})

describe('windowButtonsChange', () => {
  it('hides the lights at the start of a collapse', () => {
    expect(windowButtonsChange(true, false)).toEqual({ visible: false, delayMs: 0 })
  })

  it('shows them only once an expand has finished', () => {
    expect(windowButtonsChange(false, false)).toEqual({ visible: true, delayMs: SIDEBAR_COLLAPSE_MS })
  })

  it('applies the first sync at once, collapsed or not', () => {
    expect(windowButtonsChange(true, true)).toEqual({ visible: false, delayMs: 0 })
    expect(windowButtonsChange(false, true)).toEqual({ visible: true, delayMs: 0 })
  })
})
