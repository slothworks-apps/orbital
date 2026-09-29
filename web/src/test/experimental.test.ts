import { describe, expect, it } from 'vitest'
import { isRevealChord } from '../lib/experimental'

const base = { metaKey: true, shiftKey: true, altKey: false, ctrlKey: false }

describe('isRevealChord', () => {
  it('matches ⌘⇧. by position, whatever the layout prints', () => {
    expect(isRevealChord({ ...base, key: '>', code: 'Period' })).toBe(true)
    // Czech QWERTZ: Shift+. prints a colon.
    expect(isRevealChord({ ...base, key: ':', code: 'Period' })).toBe(true)
  })

  it('ignores the key without both modifiers, or with extra ones', () => {
    expect(isRevealChord({ ...base, shiftKey: false, key: '.', code: 'Period' })).toBe(false)
    expect(isRevealChord({ ...base, metaKey: false, key: ':', code: 'Period' })).toBe(false)
    expect(isRevealChord({ ...base, altKey: true, key: ':', code: 'Period' })).toBe(false)
    expect(isRevealChord({ ...base, key: ':', code: 'Semicolon' })).toBe(false)
  })
})
