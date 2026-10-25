import { describe, expect, it } from 'vitest'
import { followStored } from '../lib/syncedDraft'

describe('followStored', () => {
  it('takes a value from outside into a draft with no unsaved edit', () => {
    expect(followStored({ draft: 'a', base: 'a' }, 'b')).toEqual({ draft: 'b', base: 'b' })
  })

  it('keeps an unsaved edit when a value from outside arrives', () => {
    expect(followStored({ draft: 'mine', base: 'a' }, 'theirs')).toEqual({ draft: 'mine', base: 'a' })
  })

  it('is back in step once the stored value is what the draft says (its own save landing)', () => {
    const saved = followStored({ draft: 'mine', base: 'a' }, 'mine')
    expect(saved).toEqual({ draft: 'mine', base: 'mine' })
    expect(followStored(saved, 'theirs')).toEqual({ draft: 'theirs', base: 'theirs' })
  })

  it('keeps typing that went on past a save still landing', () => {
    expect(followStored({ draft: 'mine2', base: 'a' }, 'mine')).toEqual({ draft: 'mine2', base: 'a' })
  })
})
