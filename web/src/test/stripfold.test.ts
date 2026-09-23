import { describe, expect, it } from 'vitest'
import {
  FOLD_HYSTERESIS_PX,
  FOLD_MIN_PATH_PX,
  foldSavingPx,
  isFoldable,
  stripForm,
  stripLayout,
  stripMenu,
  stripWidthPx,
} from '../panels/stripFold'
import type { StripPresence } from '../panels/stripFold'

/** A live Orbital session in the desktop app, stats as a button: all six. */
const desktop: StripPresence = { stats: true, pin: true, clear: true, end: true, detach: true, collapse: true }
/** The same in a browser: no detach. */
const browser: StripPresence = { ...desktop, detach: false }
/** A detached window: neither detach nor collapse. */
const standalone: StripPresence = { ...desktop, detach: false, collapse: false }

const buttons = (form: 'expanded' | 'folded', present: StripPresence) =>
  stripLayout(form, present).map((slot) => slot.button)

describe('stripLayout', () => {
  it('draws six buttons expanded and four folded on the desktop build', () => {
    expect(buttons('expanded', desktop)).toEqual(['stats', 'pin', 'clear', 'end', 'detach', 'collapse'])
    expect(buttons('folded', desktop)).toEqual(['pin', 'end', 'more', 'collapse'])
  })

  it('draws five expanded and four folded in the browser', () => {
    expect(buttons('expanded', browser)).toEqual(['stats', 'pin', 'clear', 'end', 'collapse'])
    expect(buttons('folded', browser)).toEqual(['pin', 'end', 'more', 'collapse'])
  })

  it('folds a detached window to pin · end · ⋯', () => {
    expect(buttons('folded', standalone)).toEqual(['pin', 'end', 'more'])
  })

  it('sets collapse at the pair gap after detach or ⋯, at the session gap after End', () => {
    const margin = (form: 'expanded' | 'folded', present: StripPresence) =>
      stripLayout(form, present).find((slot) => slot.button === 'collapse')?.marginPx
    expect(margin('expanded', desktop)).toBe(6)
    expect(margin('folded', desktop)).toBe(6)
    expect(margin('expanded', browser)).toBe(10)
    expect(margin('folded', browser)).toBe(6)
  })

  it('never folds a strip where the ⋯ would stand in for a single button', () => {
    // A terminal session in the browser: stats is the only button that folds.
    const lone: StripPresence = { ...browser, clear: false, end: false }
    expect(isFoldable(lone)).toBe(false)
    expect(buttons('folded', lone)).toEqual(buttons('expanded', lone))
    expect(foldSavingPx(lone)).toBe(0)
  })

  it('reports the saving as the difference between the two widths', () => {
    expect(foldSavingPx(desktop)).toBe(stripWidthPx('expanded', desktop) - stripWidthPx('folded', desktop))
    expect(foldSavingPx(desktop)).toBeGreaterThan(0)
    expect(foldSavingPx(browser)).toBeGreaterThan(0)
  })
})

describe('stripForm', () => {
  const saving = foldSavingPx(desktop)

  it('stays expanded while the path has room', () => {
    expect(stripForm(FOLD_MIN_PATH_PX + 40, 'expanded', desktop)).toBe('expanded')
  })

  it('folds once the expanded path would drop under the line', () => {
    expect(stripForm(FOLD_MIN_PATH_PX, 'expanded', desktop)).toBe('expanded')
    expect(stripForm(FOLD_MIN_PATH_PX - 1, 'expanded', desktop)).toBe('folded')
  })

  it('judges a folded strip by the width its path would have expanded', () => {
    // Folded, the path is wider by the saving. Just past the line plus the
    // saving is still inside the hysteresis band — no flip back.
    expect(stripForm(FOLD_MIN_PATH_PX + saving, 'folded', desktop)).toBe('folded')
    expect(stripForm(FOLD_MIN_PATH_PX + FOLD_HYSTERESIS_PX - 1 + saving, 'folded', desktop)).toBe('folded')
    expect(stripForm(FOLD_MIN_PATH_PX + FOLD_HYSTERESIS_PX + saving, 'folded', desktop)).toBe('expanded')
  })

  it('holds whichever form it is in across the hysteresis band', () => {
    for (let expandedPath = FOLD_MIN_PATH_PX; expandedPath < FOLD_MIN_PATH_PX + FOLD_HYSTERESIS_PX; expandedPath++) {
      expect(stripForm(expandedPath, 'expanded', desktop)).toBe('expanded')
      expect(stripForm(expandedPath + saving, 'folded', desktop)).toBe('folded')
    }
  })

  it('does not flip back after folding at the line', () => {
    // The fold hands the saving to the path; the next measurement must not
    // read that as room to expand.
    const before = FOLD_MIN_PATH_PX - 1
    const form = stripForm(before, 'expanded', desktop)
    expect(stripForm(before + saving, form, desktop)).toBe('folded')
  })

  it('ignores a cell that has not been laid out', () => {
    expect(stripForm(0, 'expanded', desktop)).toBe('expanded')
    expect(stripForm(0, 'folded', desktop)).toBe('folded')
  })

  it('is always expanded when folding would save nothing', () => {
    const lone: StripPresence = { ...browser, clear: false, end: false }
    expect(stripForm(10, 'expanded', lone)).toBe('expanded')
    expect(stripForm(10, 'folded', lone)).toBe('expanded')
  })
})

describe('stripMenu', () => {
  it('lists stats, clear, a hairline and detach on the desktop build', () => {
    expect(stripMenu(desktop)).toEqual(['stats', 'clear', 'separator', 'detach'])
  })

  it('ends before the hairline in the browser', () => {
    expect(stripMenu(browser)).toEqual(['stats', 'clear'])
  })

  it('lists only what the strip had to give', () => {
    // A terminal session on the desktop: no clear.
    expect(stripMenu({ ...desktop, clear: false, end: false })).toEqual(['stats', 'separator', 'detach'])
  })
})
