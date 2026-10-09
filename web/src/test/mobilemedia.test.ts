import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../lib/types'
import type { FileOutcome } from '../mobile/files/fileResolver'
import { mediaItemFor, stepMedia } from '../mobile/files/mediaPaging'
import { makeNamedFileResolver, makePdfLoader, parsePdfAddress, pdfAddress, type ReadNamed } from '../mobile/files/namedFiles'

function ready(bytes: number[], mediaType: string | null = 'image/png'): FileOutcome {
  return { kind: 'ready', bytes: new Uint8Array(bytes), mediaType, w: null, h: null, readAt: 0, cached: false }
}

describe('the phone’s named files', () => {
  it('names a PDF by an address that carries its session, path and cwd', () => {
    const file = { sessionId: 's 1', path: 'docs/a&b #1.pdf', cwd: '/w/x?y' }
    expect(parsePdfAddress(pdfAddress(file))).toEqual(file)
    expect(parsePdfAddress(pdfAddress({ sessionId: 's', path: 'a.pdf' }))).toEqual({ sessionId: 's', path: 'a.pdf' })
    expect(parsePdfAddress('blob:https://x/1')).toBeNull()
    expect(parsePdfAddress('orbital-pdf:?session=s')).toBeNull()
  })

  it('answers a PDF at once and reads nothing until pdf.js asks', () => {
    const read = vi.fn<ReadNamed>()
    const resolve = makeNamedFileResolver(read)
    const url = resolve('s', 'docs/spec.pdf', '/w')
    expect(typeof url).toBe('string')
    expect(parsePdfAddress(url as string)).toEqual({ sessionId: 's', path: 'docs/spec.pdf', cwd: '/w' })
    expect(read).not.toHaveBeenCalled()
  })

  it('reads an image as `image`, once, and answers from then on at once', async () => {
    const read = vi.fn<ReadNamed>(async () => ready([1, 2]))
    const toUrl = vi.fn(() => 'blob:1')
    const resolve = makeNamedFileResolver(read, toUrl, () => undefined)
    const first = resolve('s', 'out/a.png', '/w')
    const second = resolve('s', 'out/a.png', '/w')
    expect(await first).toBe('blob:1')
    expect(await second).toBe('blob:1')
    expect(resolve('s', 'out/a.png', '/w')).toBe('blob:1')
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith({ sessionId: 's', path: 'out/a.png', as: 'image', cwd: '/w' })
    // The same path from another tree is another file.
    await resolve('s', 'out/a.png', '/w/.worktrees/b')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('fails an image the Mac did not hand over, and asks again next time', async () => {
    const read = vi
      .fn<ReadNamed>()
      .mockResolvedValueOnce({ kind: 'gone', copy: null })
      .mockResolvedValueOnce(ready([1]))
    const resolve = makeNamedFileResolver(read, () => 'blob:2', () => undefined)
    await expect(resolve('s', 'a.png')).rejects.toThrow()
    expect(await resolve('s', 'a.png')).toBe('blob:2')
  })

  it('evicts and revokes the oldest image past its bound', async () => {
    let n = 0
    const revoke = vi.fn()
    const resolve = makeNamedFileResolver(async () => ready([1]), () => `blob:${++n}`, revoke, 2)
    await resolve('s', 'a.png')
    await resolve('s', 'b.png')
    await resolve('s', 'c.png')
    expect(revoke).toHaveBeenCalledWith('blob:1')
  })

  it('loads a PDF’s bytes over `file_get` as `pdf`, and fetches any other URL', async () => {
    const read = vi.fn<ReadNamed>(async () => ready([37, 80, 68, 70], 'application/pdf'))
    const fetchBytes = vi.fn(async () => new ArrayBuffer(1))
    const load = makePdfLoader(read, fetchBytes)
    const bytes = await load(pdfAddress({ sessionId: 's', path: 'a.pdf', cwd: '/w' }))
    expect(Array.from(new Uint8Array(bytes))).toEqual([37, 80, 68, 70])
    expect(read).toHaveBeenCalledWith({ sessionId: 's', path: 'a.pdf', cwd: '/w', as: 'pdf' })
    await load('blob:held')
    expect(fetchBytes).toHaveBeenCalledWith('blob:held')
  })

  it('fails a PDF the Mac refused — an older Mac’s answer included — rather than handing pdf.js nothing', async () => {
    const load = makePdfLoader(async () => ({ kind: 'cant-show', size: null, mediaType: null }))
    await expect(load(pdfAddress({ sessionId: 's', path: 'a.pdf' }))).rejects.toThrow()
  })
})

const item = (id: string, over: Partial<MediaItem> = {}): MediaItem => ({
  id,
  kind: 'image',
  source: 'you',
  messageId: `m-${id}`,
  ts: '2026-10-09T14:07:00Z',
  ref: `r-${id}`,
  ...over,
})

describe('the phone viewer’s media paging', () => {
  const list = [
    item('a'),
    item('t1', { source: 'tool', toolRun: 'run' }),
    item('b', { source: 'agent', ref: undefined, path: 'out/b.png', cwd: '/w' }),
    item('c'),
  ]

  it('finds the item the gallery named, whatever the screen underneath', () => {
    expect(mediaItemFor({ path: null, mediaId: 'c' }, list, false)?.id).toBe('c')
  })

  it('finds a press in the session’s transcript by its ref or its path, and nothing from elsewhere', () => {
    expect(mediaItemFor({ path: null, ref: 'r-a', messageId: 'm-a' }, list, true)?.id).toBe('a')
    expect(mediaItemFor({ path: 'out/b.png', messageId: 'm-b' }, list, true)?.id).toBe('b')
    // A subagent's transcript or a task's output keeps paging through its message.
    expect(mediaItemFor({ path: 'out/b.png', messageId: 'm-b' }, list, false)).toBeUndefined()
    expect(mediaItemFor({ path: 'out/never.png' }, list, true)).toBeUndefined()
    expect(mediaItemFor({ path: 'out/b.png' }, undefined, true)).toBeUndefined()
  })

  it('steps through the shown items and stops at either end', () => {
    expect(stepMedia(list, list, 'a', -1)).toBe('a')
    expect(stepMedia(list, list, 'a', 1)).toBe('t1')
    expect(stepMedia(list, list, 'c', 1)).toBe('c')
  })

  it('steps on from a tool image the switch has just hidden', () => {
    const shown = list.filter((m) => m.source !== 'tool')
    // `t1` hidden: its place is taken by `b`, the next shown after it.
    expect(stepMedia(shown, list, 't1', 1)).toBe('c')
    expect(stepMedia(shown, list, 't1', -1)).toBe('a')
    expect(stepMedia([], list, 'a', 1)).toBeNull()
  })
})
