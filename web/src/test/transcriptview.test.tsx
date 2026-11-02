import { describe, it, expect, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { ChatMessage } from '../lib/types'
import { TranscriptView } from '../panels/TranscriptView'
import { waitingBehind } from '../lib/hookWait'

// ---------------------------------------------------------------------------
// TranscriptView — the capability the extraction exists to provide: a
// message renderer usable without a session's pagination (Task 5,
// spec: 2026-09-22-subagent-transcript-panel-design § 8 "Extraction
// first"). Everything else about TranscriptView is exercised, unedited, by
// transcript.test.tsx and transcriptmotion.test.ts through `Transcript`.
// ---------------------------------------------------------------------------

const messages: ChatMessage[] = [{ id: '1', role: 'user', text: 'hello' }]

describe('TranscriptView — paging is optional', () => {
  it('watches nothing for a finite, unpaginated buffer that fits its window', () => {
    const observerFactory = vi.fn(() => ({ observe() {}, disconnect() {} }))
    render(
      <TranscriptView
        messages={messages}
        isWorking={false}
        models={[]}
        resetKey="a"
        sessionId="s1"
        observerFactory={observerFactory}
      />
    )
    expect(observerFactory).not.toHaveBeenCalled()
  })

  it('pages through onLoadOlder when the reader reaches the top', async () => {
    let reachTop: IntersectionObserverCallback = () => {}
    const onLoadOlder = vi.fn(async () => 0)
    render(
      <TranscriptView
        messages={messages}
        isWorking={false}
        models={[]}
        resetKey="a"
        sessionId="s1"
        onLoadOlder={onLoadOlder}
        observerFactory={(callback) => {
          reachTop = callback
          return { observe() {}, disconnect() {} }
        }}
      />
    )
    await act(async () => {
      reachTop([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })
    expect(onLoadOlder).toHaveBeenCalledTimes(1)
  })
})

describe('TranscriptView — what a hook holds back', () => {
  const answered: ChatMessage[] = [
    { id: '1', role: 'user', text: 'go' },
    { id: '2', role: 'assistant', text: 'Done.' },
  ]
  /** A turn this tab sent, not echoed yet; its send answered with the uuid. */
  const local = (n: number): ChatMessage => ({ id: `local:${n}`, role: 'user', text: `next ${n}`, uuid: `l${n}` })
  /** A turn another window, the phone or the API sent, as the socket delivers it. */
  const fromElsewhere = (n: number): ChatMessage => ({ id: `sent:u${n}`, role: 'user', text: `next ${n}`, uuid: `u${n}` })
  const notice = (waiting?: string[]): ChatMessage => ({
    id: 'n1',
    role: 'notice',
    text: 'Stop hook running',
    notice: {
      level: 'info',
      hook: { event: 'Stop', count: 1, cancellable: true, messagesWaiting: waiting?.length ?? 0, ...(waiting ? { waiting } : {}) },
    },
  })
  const order = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-message-ids], [data-testid]')].map(
      (el) => el.getAttribute('data-testid') ?? el.getAttribute('data-message-ids'),
    )
  const dashed = (container: HTMLElement) =>
    [...container.querySelectorAll('[data-role="user"]')].map((el) => el.querySelector('.border-dashed') !== null)
  const view = (rows: ChatMessage[], live: ChatMessage | undefined) => (
    <TranscriptView
      messages={rows}
      isWorking
      models={[]}
      resetKey="a"
      sessionId="s1"
      liveRow={<div data-testid="live" />}
      isWaiting={waitingBehind(live)}
      waitCaption={live ? (count) => <div data-testid={`caption:${count}`} /> : undefined}
    />
  )

  it('puts the live row after what went out and before the messages waiting behind it, captioned once', () => {
    const { container, rerender } = render(view([...answered, local(1)], notice(['l1'])))
    expect(order(container)).toEqual(['1', '2', 'live', 'local:1', 'caption:1'])
    const row = container.querySelector('[data-testid="live"]')
    rerender(view([...answered, local(1), local(2)], notice(['l1', 'l2'])))
    expect(order(container)).toEqual(['1', '2', 'live', 'local:1', 'local:2', 'caption:2'])
    // A message sent behind it does not remount the row.
    expect(container.querySelector('[data-testid="live"]')).toBe(row)
  })

  it('draws a turn sent from elsewhere as waiting, under the row, while the Mac names it', () => {
    const rows = [...answered, fromElsewhere(1), fromElsewhere(2)]
    const { container, rerender } = render(view(rows, notice(['u1', 'u2'])))
    expect(order(container)).toEqual(['1', '2', 'live', 'sent:u1', 'sent:u2', 'caption:2'])
    expect(dashed(container)).toEqual([false, true, true])
    // Delivered: the Mac no longer names it, and it is an ordinary turn again.
    rerender(view(rows, notice(['u2'])))
    expect(order(container)).toEqual(['1', '2', 'sent:u1', 'live', 'sent:u2', 'caption:1'])
    expect(dashed(container)).toEqual([false, false, true])
    // The row went: nothing waits.
    rerender(view(rows, undefined))
    expect(dashed(container)).toEqual([false, false, false])
    expect(order(container)).not.toContain('caption:1')
  })

  it('leaves a pending turn the Mac does not name an ordinary one, above the row', () => {
    const { container } = render(view([...answered, local(1), { ...local(2), uuid: undefined }], notice([])))
    expect(order(container)).toEqual(['1', '2', 'local:1', 'local:2', 'live'])
    expect(dashed(container)).toEqual([false, false, false])
  })

  it('puts it last when nothing waits', () => {
    const { container } = render(view(answered, notice([])))
    expect(order(container)).toEqual(['1', '2', 'live'])
  })
})
