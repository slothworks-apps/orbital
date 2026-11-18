import { describe, expect, it, vi } from 'vitest'
import type { FileResult } from '@orbital/shared/remote/client'
import type { TunnelClient } from '../mobile/transport/clientRef'
import type { ResolverDeps } from '../mobile/files/fileResolver'
import { makePhoneViewSource, viewPayloadPath } from '../mobile/files/viewSource'

const encode = (text: string) => new TextEncoder().encode(text)
const answer = (status: number, text = ''): FileResult => ({ status, bytes: encode(text), size: text.length, mediaType: null, w: null, h: null })

type Request = TunnelClient['request']

function source(opts: { getFile?: ResolverDeps['client']['getFile']; serves?: boolean; request?: Request }) {
  const stored = new Map<string, Uint8Array>()
  const getFile = vi.fn(opts.getFile ?? (async () => answer(404)))
  const request = vi.fn<Request>(opts.request ?? (async () => ({ status: 200, body: { viewId: 'v1' } })))
  const view = makePhoneViewSource({
    client: { request },
    files: {
      client: { getFile, getBlob: vi.fn() },
      cache: {
        get: async (key) => {
          const bytes = stored.get(key)
          return bytes ? { bytes, entry: { mediaType: null, w: null, h: null, readAt: 1 } as never } : null
        },
        put: async (key, bytes) => {
          stored.set(key, bytes)
        },
      },
    },
    serves: () => opts.serves ?? true,
  })
  return { view, getFile, request }
}

describe('the phone’s view source', () => {
  it('reads the payload over REST and the data copy over file_get as view-data', async () => {
    const { view, getFile, request } = source({ getFile: async () => answer(200, '{"a":1}') })
    expect(await view.payload('s1', 'tu1')).toEqual({ viewId: 'v1' })
    expect(request).toHaveBeenCalledWith('GET', viewPayloadPath('s1', 'tu1'))
    expect(await view.data('s1', 'tu1')).toBe('{"a":1}')
    expect(getFile).toHaveBeenCalledWith('s1', 'tu1', 'view-data', expect.anything())
  })

  it('shows the copy it kept once the Mac no longer has it', async () => {
    let status = 200
    const { view } = source({ getFile: async () => answer(status, 'a,b\n1,2') })
    await view.data('s1', 'tu1')
    status = 404
    expect(await view.data('s1', 'tu1')).toBe('a,b\n1,2')
  })

  it('rejects what it cannot read, and asks nothing of a Mac too old for views', async () => {
    const { view } = source({ getFile: async () => answer(403) })
    await expect(view.data('s1', 'tu1')).rejects.toThrow()
    const old = source({ serves: false })
    await expect(old.view.payload('s1', 'tu1')).rejects.toThrow()
    await expect(old.view.data('s1', 'tu1')).rejects.toThrow()
    expect(old.request).not.toHaveBeenCalled()
    expect(old.getFile).not.toHaveBeenCalled()
  })

  it('rejects a refused payload', async () => {
    const { view } = source({ request: async () => ({ status: 404, body: { error: 'not_found' } }) })
    await expect(view.payload('s1', 'tu1')).rejects.toThrow('404')
  })
})
