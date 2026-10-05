import { describe, it, expect, vi } from 'vitest'
import { TunnelError, type FileResult } from '@orbital/shared/remote/client'

vi.mock('@capacitor/filesystem', () => ({ Directory: { Cache: 'CACHE' }, Filesystem: {} }))

import { FileCache, evictionVictims, pathKey, refKey, type CacheEntry, type CacheIO } from '../mobile/files/fileCache'
import { readPath, readRef, type ResolverDeps } from '../mobile/files/fileResolver'
import { fileKindOf, isCantShowStatus } from '../mobile/files/route'
import { progressLabel } from '../mobile/files/FileStates'
import { pagesFor } from '../mobile/screens/FileScreen'
import {
  DOUBLE_TAP_ZOOM, FIT, MAX_ZOOM, SWIPE_BACK_PX, SWIPE_PAGE_PX, clampPan, clampScale, fitSize, releaseGesture, toggleZoom,
  zoomAt, zoomLabel,
} from '../mobile/files/zoom'

function memoryIO(): CacheIO & { files: Map<string, Uint8Array>; index: string | null } {
  const io = {
    files: new Map<string, Uint8Array>(),
    index: null as string | null,
    readIndex: async () => io.index,
    writeIndex: async (json: string) => {
      io.index = json
    },
    read: async (name: string) => io.files.get(name) ?? null,
    write: async (name: string, bytes: Uint8Array) => {
      io.files.set(name, bytes)
    },
    remove: async (name: string) => {
      io.files.delete(name)
    },
    wipe: async () => {
      io.files.clear()
      io.index = null
    },
  }
  return io
}

function bytes(n: number): Uint8Array {
  return new Uint8Array(n).fill(7)
}

function file(status: number, extra: Partial<FileResult> = {}): FileResult {
  return { status, bytes: new Uint8Array(0), mediaType: null, size: null, w: null, h: null, ...extra }
}

describe('fileKindOf', () => {
  it('routes images to the viewer, text types to the preview, anything else nowhere', () => {
    expect(fileKindOf('/tmp/login.png')).toBe('image')
    expect(fileKindOf('art/logo.SVG')).toBe('image')
    expect(fileKindOf('docs/parity/Button.md')).toBe('text')
    expect(fileKindOf('server/log/out.log')).toBe('text')
    expect(fileKindOf('out/lighthouse.pdf')).toBeNull()
    expect(fileKindOf('bin/tool')).toBeNull()
  })

  it('reads 413 and 415 as can’t-be-shown, nothing else', () => {
    expect([200, 403, 404, 413, 415, 500].filter(isCantShowStatus)).toEqual([413, 415])
  })
})

describe('evictionVictims', () => {
  const entry = (key: string, size: number, lastOpened: number): CacheEntry => ({
    key, name: key, bytes: size, lastOpened, readAt: lastOpened, w: null, h: null, mediaType: null,
  })

  it('drops nothing within the bound', () => {
    expect(evictionVictims([entry('a', 5, 1), entry('b', 5, 2)], 10)).toEqual([])
  })

  it('drops the least recently opened first until the rest fit', () => {
    const victims = evictionVictims([entry('new', 4, 9), entry('old', 4, 1), entry('mid', 4, 5)], 8)
    expect(victims.map((v) => v.key)).toEqual(['old'])
    const more = evictionVictims([entry('c', 4, 3), entry('a', 4, 1), entry('b', 4, 2)], 4)
    expect(more.map((v) => v.key)).toEqual(['a', 'b'])
  })

  it('keeps the entry just written unless it alone is too large', () => {
    expect(evictionVictims([entry('a', 4, 1), entry('kept', 4, 0)], 4, 'kept').map((v) => v.key)).toEqual(['a'])
    expect(evictionVictims([entry('a', 1, 1), entry('huge', 20, 5)], 10, 'huge').map((v) => v.key)).toEqual(['a', 'huge'])
  })
})

describe('FileCache', () => {
  it('stays within its bound, dropping the least recently opened and their files', async () => {
    let t = 0
    const io = memoryIO()
    const cache = new FileCache(io, 10, () => ++t)
    await cache.put('a', bytes(4), { w: null, h: null, mediaType: null })
    await cache.put('b', bytes(4), { w: null, h: null, mediaType: null })
    await cache.get('a') // opened again: b is now the oldest
    await cache.put('c', bytes(4), { w: null, h: null, mediaType: null })

    expect(await cache.peek('b')).toBeNull()
    expect(await cache.peek('a')).not.toBeNull()
    expect(await cache.peek('c')).not.toBeNull()
    expect(io.files.size).toBe(2)
  })

  it('keeps its index across a restart, and wipes what an index never accounted for', async () => {
    const io = memoryIO()
    io.files.set('stray', bytes(1))
    const first = new FileCache(io, 100)
    await first.put('a', bytes(3), { w: 2, h: 1, mediaType: 'image/png' })
    expect(io.files.has('stray')).toBe(false)

    const second = new FileCache(io, 100)
    const hit = await second.get('a')
    expect(hit?.bytes.length).toBe(3)
    expect(hit?.entry).toMatchObject({ w: 2, h: 1, mediaType: 'image/png' })
  })

  it('reads a file the OS removed as a miss and forgets its entry', async () => {
    const io = memoryIO()
    const cache = new FileCache(io, 100)
    await cache.put('a', bytes(3), { w: null, h: null, mediaType: null })
    io.files.clear()
    expect(await cache.get('a')).toBeNull()
    expect(await cache.peek('a')).toBeNull()
  })
})

describe('the file resolver', () => {
  function deps(client: Partial<ResolverDeps['client']>) {
    const cache = new FileCache(memoryIO(), 1000)
    const full: ResolverDeps['client'] = {
      getFile: vi.fn(async () => file(404)),
      getBlob: vi.fn(async () => ({ status: 404, bytes: new Uint8Array(0), mediaType: null })),
      ...client,
    }
    return { client: full, cache }
  }
  const req = { sessionId: 's1', path: '/tmp/login.png', as: 'image' as const }

  it('reads a path from the Mac every time it is there, and refreshes the copy', async () => {
    const getFile = vi
      .fn()
      .mockResolvedValueOnce(file(200, { bytes: bytes(3), w: 4, h: 2, mediaType: 'image/png' }))
      .mockResolvedValueOnce(file(200, { bytes: bytes(5), w: 4, h: 2, mediaType: 'image/png' }))
    const d = deps({ getFile })
    expect(await readPath(d, req)).toMatchObject({ kind: 'ready', cached: false, w: 4, h: 2 })
    const again = await readPath(d, req)
    expect(getFile).toHaveBeenCalledTimes(2)
    expect(again.kind === 'ready' && again.bytes.length).toBe(5)
    expect((await d.cache.get(pathKey('s1', req.path)))?.bytes.length).toBe(5)
  })

  it('shows the copy with its age while the Mac is away', async () => {
    const d = deps({ getFile: vi.fn().mockRejectedValue(new TunnelError('offline')) })
    await d.cache.put(pathKey('s1', req.path), bytes(3), { w: 4, h: 2, mediaType: 'image/png' })
    const readAt = (await d.cache.peek(pathKey('s1', req.path)))?.readAt
    expect(await readPath(d, req)).toMatchObject({ kind: 'ready', cached: true, readAt, w: 4, h: 2 })
  })

  it('waits for the Mac when it is away and the phone has no copy', async () => {
    const d = deps({ getFile: vi.fn().mockRejectedValue(new TunnelError('offline')) })
    expect(await readPath(d, req)).toEqual({ kind: 'waits' })
  })

  it('turns 413 and 415 into can’t-be-shown, with the size when known', async () => {
    const big = deps({ getFile: vi.fn(async () => file(413, { size: 900_000 })) })
    expect(await readPath(big, { ...req, path: 'logs/huge.log', as: 'text' })).toEqual({
      kind: 'cant-show', size: 900_000, mediaType: null,
    })
    const binary = deps({ getFile: vi.fn(async () => file(415, { mediaType: 'application/octet-stream' })) })
    expect(await readPath(binary, { ...req, path: 'data/x.json', as: 'text' })).toMatchObject({
      kind: 'cant-show', size: null,
    })
  })

  it('a missing file is gone, with the copy the phone kept', async () => {
    const d = deps({ getFile: vi.fn(async () => file(404)) })
    expect(await readPath(d, req)).toEqual({ kind: 'gone', copy: null })
    await d.cache.put(pathKey('s1', req.path), bytes(3), { w: 4, h: 2, mediaType: 'image/png' })
    expect(await readPath(d, req)).toMatchObject({ kind: 'gone', copy: { kind: 'ready', cached: true } })
  })

  it('outside the session is its own answer', async () => {
    const d = deps({ getFile: vi.fn(async () => file(403)) })
    expect(await readPath(d, req)).toEqual({ kind: 'outside' })
  })

  it('a dropped transfer reports how far it got', async () => {
    const getFile = vi.fn(async (_s: string, _p: string, _a: string, opts?: { onProgress?: (n: number, t: number | null) => void }) => {
      opts?.onProgress?.(40_000, 186_000)
      throw new TunnelError('timeout')
    })
    const d = deps({ getFile })
    expect(await readPath(d, req)).toEqual({ kind: 'failed', received: 40_000 })
  })

  it('never asks the Mac again for a ref it has', async () => {
    const getBlob = vi.fn(async () => ({ status: 200, bytes: bytes(3), mediaType: 'image/png' }))
    const d = deps({ getBlob })
    expect(await readRef(d, 'abc.png')).toMatchObject({ kind: 'ready' })
    expect(await readRef(d, 'abc.png')).toMatchObject({ kind: 'ready' })
    expect(getBlob).toHaveBeenCalledTimes(1)
    expect(await d.cache.get(refKey('abc.png'))).not.toBeNull()
  })
})

describe('the viewer’s zoom', () => {
  const stage = { w: 400, h: 800 }
  const fitted = fitSize({ w: 1280, h: 800 }, stage) // 400 × 250

  it('fits the image inside the stage', () => {
    expect(fitted).toEqual({ w: 400, h: 250 })
  })

  it('holds the scale between fit and the maximum', () => {
    expect(clampScale(0.3)).toBe(1)
    expect(clampScale(MAX_ZOOM + 3)).toBe(MAX_ZOOM)
  })

  it('pans no further than the zoomed image overhangs the stage, and centres an axis it does not fill', () => {
    // At 4×: 1600 × 1000 inside 400 × 800 → 600 px of room on x, 100 on y.
    expect(clampPan({ scale: 4, x: 5000, y: -5000 }, fitted, stage)).toEqual({ scale: 4, x: 600, y: -100 })
    // At 2×: 800 × 500, shorter than the stage → y stays centred.
    expect(clampPan({ scale: 2, x: -10, y: 80 }, fitted, stage)).toEqual({ scale: 2, x: -10, y: 0 })
  })

  it('a double-tap zooms about the tap, and the next returns to fit', () => {
    const zoomed = toggleZoom(FIT, { x: 100, y: 0 }, fitted, stage)
    expect(zoomed.scale).toBe(DOUBLE_TAP_ZOOM)
    // The tapped point stays under the finger: 100 - (100 - 0) × 2.5.
    expect(zoomed.x).toBe(-150)
    expect(toggleZoom(zoomed, { x: 0, y: 0 }, fitted, stage)).toEqual(FIT)
  })

  it('a pinch keeps the point between the fingers in place', () => {
    const v = zoomAt(FIT, 2, { x: -50, y: 20 }, fitted, stage)
    expect(v).toEqual({ scale: 2, x: 50, y: 0 }) // y clamped: 500 tall fits the stage
  })

  it('a drag at fit goes back when it runs down far enough, pages when sideways, and does nothing zoomed in', () => {
    expect(releaseGesture(1, 10, SWIPE_BACK_PX + 1)).toBe('back')
    expect(releaseGesture(1, 10, SWIPE_BACK_PX - 1)).toBeNull()
    expect(releaseGesture(1, -(SWIPE_PAGE_PX + 1), 5)).toBe('next')
    expect(releaseGesture(1, SWIPE_PAGE_PX + 1, 5)).toBe('prev')
    expect(releaseGesture(1, SWIPE_BACK_PX + 10, SWIPE_BACK_PX + 1)).toBe('prev')
    expect(releaseGesture(2, 0, SWIPE_BACK_PX * 3)).toBeNull()
  })

  it('labels fit, and any zoom to one decimal', () => {
    expect(zoomLabel(1)).toBe('fit')
    expect(zoomLabel(2.5)).toBe('2.5×')
    expect(zoomLabel(3.04)).toBe('3×')
  })
})

describe('the viewer’s pages', () => {
  const message = {
    role: 'assistant' as const,
    text: 'Saved to /tmp/login.png and /tmp/login-2x.png.',
    images: [{ ref: 'abc.png', w: 1, h: 1, bytes: 1 }],
  }

  it('pages through the message’s images from the one pressed', () => {
    const { items, start } = pagesFor({ path: '/tmp/login-2x.png', ref: undefined }, message)
    expect(items.map((i) => (i.kind === 'ref' ? i.ref : i.path))).toEqual(['abc.png', '/tmp/login.png', '/tmp/login-2x.png'])
    expect(start).toBe(2)
  })

  it('shows the pressed image alone when its message is unknown', () => {
    expect(pagesFor({ path: '/tmp/x.png', ref: undefined }, undefined)).toEqual({ items: [{ kind: 'path', path: '/tmp/x.png' }], start: 0 })
    expect(pagesFor({ path: null, ref: 'r.png' }, undefined).items.map((i) => i.kind)).toEqual(['ref'])
  })
})

describe('the byte count', () => {
  it('reads the byte count in one unit when both sides share it', () => {
    expect(progressLabel(116 * 1024, 186 * 1024)).toBe('116 of 186 KB')
    expect(progressLabel(512, 2 * 1024 * 1024)).toBe('512 B of 2 MB')
    expect(progressLabel(40 * 1024, null)).toBe('40 KB')
  })
})
