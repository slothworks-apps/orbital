import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileResult } from '@orbital/shared/remote/client'
import type { ViewPayload } from '@orbital/shared/views'
import type { ResolverDeps } from '../mobile/files/fileResolver'
import { makePhoneViewSource } from '../mobile/files/viewSource'
import { ApiError, api } from '../lib/api'
import { viewsEnabled } from '../lib/experimental'
import { takeMacViewsSetting } from '../mobile/questionSetting'
import { useMobile } from '../mobile/state'
import { MAC_FEATURES } from '../mobile/version'
import { useOrbital } from '../store/store'

const encode = (text: string) => new TextEncoder().encode(text)
const answer = (status: number, text = ''): FileResult => ({ status, bytes: encode(text), size: text.length, mediaType: null, w: null, h: null })

type Payload = typeof api.viewPayload

function source(opts: { getFile?: ResolverDeps['client']['getFile']; serves?: boolean; payload?: Payload }) {
  const stored = new Map<string, Uint8Array>()
  const getFile = vi.fn(opts.getFile ?? (async () => answer(404)))
  const request = vi
    .spyOn(api, 'viewPayload')
    .mockImplementation(opts.payload ?? (async () => ({ viewId: 'v1' }) as ViewPayload))
  const view = makePhoneViewSource({
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
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the payload over REST and the data copy over file_get as view-data', async () => {
    const { view, getFile, request } = source({ getFile: async () => answer(200, '{"a":1}') })
    expect(await view.payload('s1', 'tu1')).toEqual({ viewId: 'v1' })
    expect(request).toHaveBeenCalledWith('s1', 'tu1')
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
    const { view } = source({ payload: async () => Promise.reject(new ApiError('not_found', 404)) })
    await expect(view.payload('s1', 'tu1')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('Labs → Views on the phone', () => {
  it('lists view items only from a Mac that serves views, and only while it is on', () => {
    const on = () => viewsEnabled(useOrbital.getState().settings)

    useMobile.setState({ macVersion: '0.1.0' })
    takeMacViewsSetting(true)
    expect(on()).toBe(false)

    useMobile.setState({ macVersion: MAC_FEATURES.views })
    takeMacViewsSetting(true)
    expect(on()).toBe(true)
    takeMacViewsSetting(false)
    expect(on()).toBe(false)
  })
})
