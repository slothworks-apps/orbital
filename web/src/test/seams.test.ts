import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { api, configureApi, defaultApiFetch } from '../lib/api'
import { apiImagePath, configureImages, resolveImage, useImageUrl } from '../lib/images'

afterEach(() => {
  configureApi({ fetch: defaultApiFetch, upload: null })
  configureImages({ resolve: apiImagePath })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('configureApi', () => {
  it('routes request() through the configured fetch', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json({ session: { id: 's1' } }))
    configureApi({ fetch })
    await expect(api.getSession('s1')).resolves.toEqual({ session: { id: 's1' } })
    expect(fetch).toHaveBeenCalledWith('/api/sessions/s1', expect.objectContaining({ method: 'GET' }))
  })

  it('routes the calls that bypass request() too', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json({ content: 'x', size: 1, mtimeMs: 0, lines: 1 }))
    configureApi({ fetch })
    await api.filePreview('s1', '/a b')
    expect(fetch.mock.calls[0][0]).toBe('/api/files?session=s1&path=%2Fa+b')
  })

  it('hands an upload to the configured uploader and never to the fetch', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json({}))
    const entry = { ref: 'a.jpg', w: 1568, h: 1176, bytes: 9 }
    const upload = vi.fn(async () => ({ kind: 'ok' as const, entry }))
    configureApi({ fetch, upload })
    const file = new File(['x'], 'p.jpg', { type: 'image/jpeg' })
    await expect(api.uploadAttachment('s1', file)).resolves.toEqual({ kind: 'ok', entry })
    expect(upload).toHaveBeenCalledWith('s1', file, undefined)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('restores the multipart POST when the uploader is cleared', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json({ ref: 'a.png', w: 1, h: 1, bytes: 1 }))
    const upload = vi.fn(async () => ({ kind: 'empty' as const }))
    configureApi({ fetch, upload })
    configureApi({ upload: null })
    await api.uploadAttachment('s1', new File(['x'], 'a.png', { type: 'image/png' }))
    expect(upload).not.toHaveBeenCalled()
    expect(fetch.mock.calls[0][0]).toBe('/api/sessions/s1/attachments')
    expect(fetch.mock.calls[0][1]?.body).toBeInstanceOf(FormData)
  })

  it('reads the desktop defaults from their route', async () => {
    const body = { permissionMode: 'acceptEdits', model: 'opus', rememberModelPerProject: true }
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json(body))
    configureApi({ fetch })
    await expect(api.sessionDefaults()).resolves.toEqual(body)
    expect(fetch).toHaveBeenCalledWith('/api/sessions/defaults', expect.objectContaining({ method: 'GET' }))
  })
})

describe('images', () => {
  it('resolves a ref to the API path by default, synchronously', () => {
    expect(resolveImage('abc.png')).toBe('/api/images/abc.png')
    const { result } = renderHook(() => useImageUrl('abc.png'))
    expect(result.current).toMatchObject({ url: '/api/images/abc.png', failed: false, async: false })
  })

  it('waits for an async resolver, fails without throwing, and retries', async () => {
    const resolve = vi
      .fn<(ref: string) => string | Promise<string>>()
      .mockImplementationOnce(() => Promise.reject(new Error('gone')))
      .mockImplementationOnce(() => Promise.resolve('blob:x'))
    configureImages({ resolve })
    const { result } = renderHook(() => useImageUrl('abc.png'))
    expect(result.current.url).toBeNull()
    await waitFor(() => expect(result.current.failed).toBe(true))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.url).toBe('blob:x'))
    expect(result.current.async).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(2)
  })
})
