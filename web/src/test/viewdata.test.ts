import { describe, expect, it, vi } from 'vitest'
import type { ViewPayload } from '@orbital/shared/views'
import { viewDataOf } from '../lib/views/load'
import type { ViewDataSource } from '../lib/views/source'

const payload = (toolUseId: string, format: 'json' | 'csv' = 'json'): ViewPayload =>
  ({ toolUseId, data: { format, bytes: 10, inline: false } }) as ViewPayload

describe('viewDataOf', () => {
  it('reads a data copy once, however often the view wakes', async () => {
    const data = vi.fn<ViewDataSource['data']>(async () => '{"a":1}')
    const source: ViewDataSource = { payload: vi.fn(), data }
    expect(await viewDataOf('s1', payload('cache-1'), source)).toEqual({ a: 1 })
    expect(await viewDataOf('s1', payload('cache-1'), source)).toEqual({ a: 1 })
    expect(data).toHaveBeenCalledTimes(1)
  })

  it('asks again after a read that failed', async () => {
    let fail = true
    const data = vi.fn<ViewDataSource['data']>(async () => {
      if (fail) throw new Error('offline')
      return 'a,b'
    })
    const source: ViewDataSource = { payload: vi.fn(), data }
    await expect(viewDataOf('s1', payload('cache-2', 'csv'), source)).rejects.toThrow('offline')
    fail = false
    expect(await viewDataOf('s1', payload('cache-2', 'csv'), source)).toBe('a,b')
    expect(data).toHaveBeenCalledTimes(2)
  })

  it('keeps only the newest few', async () => {
    const data = vi.fn<ViewDataSource['data']>(async (_s, id) => JSON.stringify(id))
    const source: ViewDataSource = { payload: vi.fn(), data }
    for (let i = 0; i < 10; i++) await viewDataOf('s2', payload(`lru-${i}`), source)
    await viewDataOf('s2', payload('lru-0'), source)
    expect(data).toHaveBeenCalledTimes(11)
  })
})
