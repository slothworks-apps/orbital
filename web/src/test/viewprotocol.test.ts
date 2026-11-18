import { describe, expect, it } from 'vitest'
import { VIEW_SEND_MAX_BYTES } from '@orbital/shared/views'
import { MESSAGE_TAG } from '../lib/views/bridge'
import { VIEW_SEND_INTERVAL_MS, readFrameMessage, type FrameContext } from '../lib/views/protocol'

const frame = {}
const ctx = (over: Partial<FrameContext> = {}): FrameContext => ({
  frame,
  userActive: true,
  frameFocused: true,
  now: 10_000,
  lastSendAt: null,
  waiting: false,
  answered: false,
  otherDecisionPending: false,
  ...over,
})
const send = (value: unknown) => ({ source: frame, data: { tag: MESSAGE_TAG, type: 'send', value } })

describe('readFrameMessage', () => {
  it('takes messages only from the frame’s own window', () => {
    expect(readFrameMessage({ source: {}, data: { tag: MESSAGE_TAG, type: 'ready' } }, ctx()).kind).toBe('ignore')
    expect(readFrameMessage({ source: null, data: { tag: MESSAGE_TAG, type: 'ready' } }, ctx({ frame: null })).kind).toBe('ignore')
    expect(readFrameMessage({ source: frame, data: { tag: MESSAGE_TAG, type: 'ready' } }, ctx()).kind).toBe('ready')
  })

  it('ignores what does not have the bridge’s shape', () => {
    for (const data of [
      null,
      'ready',
      { type: 'ready' },
      { tag: 'other', type: 'ready' },
      { tag: MESSAGE_TAG, type: 'navigate', url: 'https://x.dev' },
      { tag: MESSAGE_TAG, type: 'height', height: 'tall' },
      { tag: MESSAGE_TAG, type: 'error', kind: 'boom', message: 'x' },
    ]) {
      expect(readFrameMessage({ source: frame, data }, ctx()).kind).toBe('ignore')
    }
  })

  it('opens only web and mail links', () => {
    const open = (url: string) => readFrameMessage({ source: frame, data: { tag: MESSAGE_TAG, type: 'open', url } }, ctx())
    expect(open('https://example.com/a')).toEqual({ kind: 'open', url: 'https://example.com/a' })
    expect(open('mailto:a@b.c').kind).toBe('open')
    expect(open('javascript:alert(1)').kind).toBe('ignore')
    expect(open('file:///etc/passwd').kind).toBe('ignore')
  })

  it('sends only inside a user gesture', () => {
    expect(readFrameMessage(send(1), ctx({ userActive: false }))).toEqual({ kind: 'refused', reason: 'gesture' })
    expect(readFrameMessage(send(1), ctx())).toEqual({ kind: 'send', as: 'message', value: 1 })
  })

  it('sends only when the gesture went into this frame, not elsewhere in Orbital', () => {
    // A click or typing elsewhere activates Orbital's window, but the focus is not in the frame.
    expect(readFrameMessage(send(1), ctx({ userActive: true, frameFocused: false }))).toEqual({ kind: 'refused', reason: 'gesture' })
    // The frame kept the focus, but the gesture has run out: a timer in the page.
    expect(readFrameMessage(send(1), ctx({ userActive: false, frameFocused: true }))).toEqual({ kind: 'refused', reason: 'gesture' })
  })

  it('opens a link only inside a gesture in the frame, at most once a second', () => {
    const open = (over: Partial<FrameContext>) =>
      readFrameMessage({ source: frame, data: { tag: MESSAGE_TAG, type: 'open', url: 'https://example.com/?d=1' } }, ctx(over))
    expect(open({ userActive: false })).toEqual({ kind: 'refused', reason: 'gesture' })
    expect(open({ frameFocused: false })).toEqual({ kind: 'refused', reason: 'gesture' })
    expect(open({ lastOpenAt: 10_000 - VIEW_SEND_INTERVAL_MS + 1 })).toEqual({ kind: 'refused', reason: 'rate' })
    expect(open({ lastOpenAt: 10_000 - VIEW_SEND_INTERVAL_MS }).kind).toBe('open')
  })

  it('sends at most once a second', () => {
    expect(readFrameMessage(send(1), ctx({ lastSendAt: 10_000 - VIEW_SEND_INTERVAL_MS + 1 }))).toEqual({ kind: 'refused', reason: 'rate' })
    expect(readFrameMessage(send(1), ctx({ lastSendAt: 10_000 - VIEW_SEND_INTERVAL_MS })).kind).toBe('send')
  })

  it('refuses a value too large to send', () => {
    expect(readFrameMessage(send('x'.repeat(VIEW_SEND_MAX_BYTES)), ctx())).toEqual({ kind: 'refused', reason: 'size' })
    // In UTF-8 bytes, not characters.
    expect(readFrameMessage(send('é'.repeat(VIEW_SEND_MAX_BYTES / 2)), ctx())).toEqual({ kind: 'refused', reason: 'size' })
    expect(readFrameMessage(send('é'.repeat(VIEW_SEND_MAX_BYTES / 2 - 2)), ctx()).kind).toBe('send')
  })

  it('takes a waiting view’s first send as its answer, and nothing after', () => {
    expect(readFrameMessage(send(['Jan']), ctx({ waiting: true }))).toEqual({ kind: 'send', as: 'answer', value: ['Jan'] })
    expect(readFrameMessage(send(['Mar']), ctx({ waiting: false, answered: true }))).toEqual({ kind: 'refused', reason: 'answered' })
  })

  it('answers its own wait even while that wait is the session’s decision', () => {
    expect(readFrameMessage(send(1), ctx({ waiting: true, otherDecisionPending: false })).kind).toBe('send')
  })

  it('keeps a view that does not wait from sending while the session waits on something else', () => {
    expect(readFrameMessage(send(1), ctx({ otherDecisionPending: true }))).toEqual({ kind: 'refused', reason: 'blocked' })
  })

  it('sends nothing while the session’s device is offline', () => {
    expect(readFrameMessage(send(1), ctx({ offline: true }))).toEqual({ kind: 'refused', reason: 'offline' })
  })
})
