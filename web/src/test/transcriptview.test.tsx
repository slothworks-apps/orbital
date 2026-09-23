import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
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

describe('TranscriptView — load-older is optional', () => {
  it('renders no "load older" control when onLoadOlder is absent (a finite, unpaginated buffer)', () => {
    render(
      <TranscriptView
        messages={messages}
        isWorking={false}
        models={[]}
        resetKey="a"
        sessionId="s1"
      />
    )
    expect(screen.queryByRole('button', { name: /load older/i })).not.toBeInTheDocument()
  })

  it('renders a "load older" control when onLoadOlder is supplied', () => {
    render(
      <TranscriptView
        messages={messages}
        isWorking={false}
        models={[]}
        resetKey="a"
        sessionId="s1"
        onLoadOlder={async () => 0}
      />
    )
    expect(screen.getByRole('button', { name: /load older/i })).toBeInTheDocument()
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
