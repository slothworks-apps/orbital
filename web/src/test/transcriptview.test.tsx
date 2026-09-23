import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import type { ChatMessage } from '../lib/types'
import { TranscriptView } from '../panels/TranscriptView'

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

describe('TranscriptView — `compact` selects the thinking-block variant', () => {
  const thinkingMessages: ChatMessage[] = [
    { id: '1', role: 'thinking', text: 'weighing the two approaches' },
  ]

  it('defaults to the boxed variant, collapsed — the parent transcript', () => {
    const { container } = render(
      <TranscriptView messages={thinkingMessages} isWorking={false} models={[]} resetKey="a" sessionId="s1" />
    )
    const block = container.querySelector('[data-role="thinking"]')
    expect(block).toHaveAttribute('data-thinking-variant', 'boxed')
    expect(screen.queryByText('weighing the two approaches')).not.toBeInTheDocument()
  })

  it('switches to the hairline variant, expanded — the 380px subagent panel', () => {
    const { container } = render(
      <TranscriptView
        messages={thinkingMessages}
        isWorking={false}
        models={[]}
        resetKey="a"
        sessionId="s1"
        compact
      />
    )
    const block = container.querySelector('[data-role="thinking"]')
    expect(block).toHaveAttribute('data-thinking-variant', 'compact')
    expect(screen.getByText('weighing the two approaches')).toBeInTheDocument()
  })
})
