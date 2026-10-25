import { describe, expect, it, vi } from 'vitest'
import type { ApiSession } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { notOlderThanHeld } from '../store/store'

const at = (id: string, lastAt: number | null, tagIds: number[] = []) => ({ id, lastAt, tagIds }) as unknown as ApiSession

describe('notOlderThanHeld', () => {
  it('drops a snapshot session the store holds newer, and keeps the rest', () => {
    const held = { a: at('a', 20), b: at('b', 10), c: at('c', null) }
    const snapshot = [at('a', 10), at('b', 10, [3]), at('c', 5), at('d', 1)]
    expect(notOlderThanHeld(held, snapshot).map((s) => s.id)).toEqual(['b', 'c', 'd'])
  })

  it('drops a snapshot session without a lastAt when the store holds one', () => {
    expect(notOlderThanHeld({ a: at('a', 20) }, [at('a', null)])).toEqual([])
  })
})
