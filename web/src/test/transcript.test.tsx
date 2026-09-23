import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ChatMessage, ErrorRecord, OrbitalModel } from '../lib/types'
import { useOrbital, type OrbitalState, type OrbitalUiState } from '../store/store'

// ---------------------------------------------------------------------------
// highlight.ts
// ---------------------------------------------------------------------------

import { highlightCode, ansiToHtml } from '../lib/highlight'

describe('ansiToHtml', () => {
  it('colorizes ANSI SGR codes into styled spans', () => {
    const html = ansiToHtml('[32m✓[0m')
    expect(html).toContain('✓')
    // anser wraps colored runs in a <span ...> carrying a color style/class
    expect(html).toMatch(/<span[^>]*(color|ansi-)[^>]*>/)
  })

  it('escapes HTML in the input before colorizing (no raw markup injection)', () => {
    const html = ansiToHtml('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})

describe('highlightCode', () => {
  it('highlights a known language via shiki, resolving to trusted HTML', async () => {
    const html = await highlightCode('const x = 1', 'javascript')
    expect(html).toContain('shiki')
    expect(html).toContain('<pre')
  })

  it('falls back to plain escaped <pre> for an unknown language, without throwing', async () => {
    const html = await highlightCode('<b>not code</b>', 'not-a-real-lang')
    expect(html).toContain('<pre>')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>not code</b>')
  })

  it('falls back to plain escaped <pre> when the shiki module fails to load, without throwing', async () => {
    // A fresh module instance is needed so this doesn't touch the
    // already-warmed singleton the other highlightCode tests share.
    vi.resetModules()
    vi.doMock('shiki', () => {
      throw new Error('simulated dynamic import failure')
    })

    const fresh = await import('../lib/highlight')
    await expect(fresh.highlightCode('<b>x</b>', 'javascript')).resolves.toContain('&lt;b&gt;')

    vi.doUnmock('shiki')
    vi.resetModules()
  })

  it('clears the cached singleton promise on failure so a later call can retry instead of staying wedged', async () => {
    vi.resetModules()
    let attempt = 0
    vi.doMock('shiki', async () => {
      attempt += 1
      if (attempt === 1) throw new Error('simulated transient failure')
      return vi.importActual<typeof import('shiki')>('shiki')
    })

    const fresh = await import('../lib/highlight')

    // First call: the mocked import throws -> safe fallback, no highlighting.
    const first = await fresh.highlightCode('const x = 1', 'javascript')
    expect(first).toBe('<pre><code>const x = 1</code></pre>')

    // Second call: import succeeds this time -> real shiki highlighting,
    // proving the failed attempt didn't permanently cache a rejected promise.
    const second = await fresh.highlightCode('const x = 1', 'javascript')
    expect(second).toContain('shiki')
    expect(attempt).toBe(2)

    vi.doUnmock('shiki')
    vi.resetModules()
  })
})

// ---------------------------------------------------------------------------
// MessageView
// ---------------------------------------------------------------------------

import { MessageView } from '../panels/MessageView'

function makeMessage(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'assistant',
    ...overrides,
  }
}

describe('MessageView', () => {
  it('renders markdown formatting', () => {
    render(<MessageView message={makeMessage({ id: '1', text: 'hello **world**' })} />)
    expect(screen.getByText('world').tagName).toBe('STRONG')
  })

  it('renders a GFM table as an actual <table>', () => {
    const text = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    render(<MessageView message={makeMessage({ id: '1', text })} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('shows an accessible plain <pre> fallback for a code block while highlighting is pending, then swaps in the highlighted result', async () => {
    const text = '```javascript\nconst x = 1\n```'
    const { container } = render(<MessageView message={makeMessage({ id: '1', text })} />)

    // Synchronously (before the highlightCode promise resolves) the plain,
    // escaped fallback must already be in the DOM.
    const pre = container.querySelector('pre')
    expect(pre).toBeInTheDocument()
    expect(pre?.textContent).toContain('const x = 1')

    await waitFor(() => {
      expect(container.querySelector('pre.shiki')).toBeInTheDocument()
    })
  })

})

// ---------------------------------------------------------------------------
// Transcript images (spec: 2026-09-18-transcript-images-design)
// ---------------------------------------------------------------------------

const IMG = { ref: `${'a'.repeat(64)}.png`, w: 1512, h: 982, bytes: 1_200_000 }

describe('MessageView images', () => {
  it('an image-only user turn renders the thumbnail as the bubble — no empty markdown bubble', () => {
    const { container } = render(
      <MessageView message={makeMessage({ id: '1', role: 'user', images: [IMG] })} />
    )
    const img = container.querySelector('img')
    expect(img).toBeInTheDocument()
    expect(img!.getAttribute('src')).toBe(`/api/images/${IMG.ref}`)
    expect(container.querySelector('.message-markdown')).not.toBeInTheDocument()
  })

  it('text + image renders the bubble with the image below it', () => {
    const { container } = render(
      <MessageView message={makeMessage({ id: '1', role: 'user', text: 'before/after', images: [IMG] })} />
    )
    expect(container.querySelector('.message-markdown')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeInTheDocument()
  })

  it('clicking a thumbnail opens the lightbox dialog; its close control dismisses it', () => {
    render(<MessageView message={makeMessage({ id: '1', role: 'user', images: [IMG] })} />)
    fireEvent.click(screen.getByRole('button', { name: /open image/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    // usePresence holds the node through the exit fade; it must at least be inert.
    const dialog = screen.queryByRole('dialog')
    if (dialog) expect(dialog.closest('[data-state="exiting"]')).not.toBeNull()
  })

  it('a pruned image swaps to the NOT IN CACHE placeholder and stops being clickable', () => {
    const { container } = render(
      <MessageView message={makeMessage({ id: '1', role: 'user', images: [IMG] })} />
    )
    fireEvent.error(container.querySelector('img')!)
    expect(screen.getByText('NOT IN CACHE')).toBeInTheDocument()
    expect(container.querySelector('img')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /open image/i })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// ToolRow
// ---------------------------------------------------------------------------

import { ToolRow, salientInput } from '../panels/ToolRow'

function makeToolUse(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'tool_use',
    toolUseId: overrides.id,
    ...overrides,
  }
}

function makeToolResult(overrides: Partial<ChatMessage> & { id: string; toolUseId: string }): ChatMessage {
  return {
    role: 'tool_result',
    ...overrides,
  }
}

describe('salientInput', () => {
  it('extracts `command` for Bash', () => {
    expect(salientInput('Bash', { command: 'npm test' })).toBe('npm test')
  })

  it('extracts `file_path` for Read/Edit/Write', () => {
    expect(salientInput('Read', { file_path: '/a.ts' })).toBe('/a.ts')
    expect(salientInput('Edit', { file_path: '/b.ts' })).toBe('/b.ts')
    expect(salientInput('Write', { file_path: '/c.ts' })).toBe('/c.ts')
  })

  it('extracts `description` for Task', () => {
    expect(salientInput('Task', { description: 'do the thing', prompt: 'long...' })).toBe('do the thing')
  })

  it('falls back to the first string value for unknown tools', () => {
    expect(salientInput('Glob', { pattern: '**/*.ts', extra: 1 })).toBe('**/*.ts')
  })

  it('returns an empty string when there is no usable input', () => {
    expect(salientInput('Bash', undefined)).toBe('')
    expect(salientInput('Weird', {})).toBe('')
  })
})

describe('ToolRow', () => {
  it('renders an image result as a thumbnail with a dims · size readout, never JSON', () => {
    const { container } = render(
      <ToolRow
        toolUse={makeToolUse({ id: 't1', toolName: 'Playwright' })}
        toolResult={makeToolResult({
          id: 'r1', toolUseId: 't1', text: '',
          images: [{ ref: `${'b'.repeat(64)}.png`, w: 1280, h: 800, bytes: 219_136 }],
        })}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Playwright/ }))
    const img = container.querySelector('img')
    expect(img).toBeInTheDocument()
    expect(img!.getAttribute('src')).toBe(`/api/images/${'b'.repeat(64)}.png`)
    expect(screen.getByText(/1280×800/)).toBeInTheDocument()
    expect(screen.getByText(/214 KB/)).toBeInTheDocument()
  })

  it('expands to show the full input JSON and the result on click', async () => {
    const user = userEvent.setup()
    const toolUse = makeToolUse({ id: 't1', toolName: 'Read', toolInput: { file_path: '/a.ts' } })
    const toolResult = makeToolResult({ id: 'r1', toolUseId: 't1', text: 'file contents here' })

    render(<ToolRow toolUse={toolUse} toolResult={toolResult} />)
    expect(screen.queryByText(/file contents here/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Read: \/a\.ts/ }))

    expect(screen.getByText(/"file_path"/)).toBeInTheDocument()
    expect(screen.getByText(/file contents here/)).toBeInTheDocument()
  })

  it('renders Bash results through ansiToHtml, producing colored spans', async () => {
    const user = userEvent.setup()
    const toolUse = makeToolUse({ id: 't1', toolName: 'Bash', toolInput: { command: 'npm test' } })
    const toolResult = makeToolResult({ id: 'r1', toolUseId: 't1', text: '[32mPASS[0m' })

    const { container } = render(<ToolRow toolUse={toolUse} toolResult={toolResult} />)
    await user.click(screen.getByRole('button', { name: /Bash: npm test/ }))

    expect(screen.getByText('PASS')).toBeInTheDocument()
    expect(container.querySelector('span[style*="color"], span[class*="ansi-"]')).toBeInTheDocument()
  })

  it('shows a pulsing dot while the tool has no result yet (running state)', () => {
    const { rerender } = render(
      <ToolRow toolUse={makeToolUse({ id: 't1', toolName: 'Bash', toolInput: { command: 'npm test' } })} />
    )
    expect(screen.getByTestId('tool-running-dot')).toBeInTheDocument()

    rerender(
      <ToolRow
        toolUse={makeToolUse({ id: 't1', toolName: 'Bash', toolInput: { command: 'npm test' } })}
        toolResult={makeToolResult({ id: 'r1', toolUseId: 't1', text: 'ok' })}
      />
    )
    expect(screen.queryByTestId('tool-running-dot')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Pressable paths (spec: 2026-09-19-file-viewer-design)
// ---------------------------------------------------------------------------

describe('ToolRow: pressable path', () => {
  beforeEach(() => {
    useOrbital.setState((s) => ({ ui: { ...s.ui, fileViewer: null } }))
  })

  it('pressing the path opens the viewer and leaves the row collapsed', () => {
    const { container } = render(
      <ToolRow toolUse={makeToolUse({ id: 't1', toolName: 'Read', toolInput: { file_path: '/a/b/store.ts' } })} />
    )

    fireEvent.click(container.querySelector('[data-path-button]')!)

    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: '/a/b/store.ts', line: null })
    expect(container.querySelector('[data-role="tool"]')).toHaveAttribute('data-expanded', 'false')
  })

  it('pressing anywhere else toggles the row without opening the viewer', () => {
    const { container } = render(
      <ToolRow toolUse={makeToolUse({ id: 't1', toolName: 'Read', toolInput: { file_path: '/a/b/store.ts' } })} />
    )

    fireEvent.click(screen.getByRole('button', { name: /Read: \/a\/b\/store\.ts/ }))

    expect(container.querySelector('[data-role="tool"]')).toHaveAttribute('data-expanded', 'true')
    expect(useOrbital.getState().ui.fileViewer).toBeNull()
  })

  it('renders the expanded INPUT file_path value as a path button too', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ToolRow
        toolUse={makeToolUse({
          id: 't1',
          toolName: 'Edit',
          toolInput: { file_path: '/a/b/store.ts', old_string: 'x', new_string: 'y' },
        })}
      />
    )

    await user.click(screen.getByRole('button', { name: /Edit: \/a\/b\/store\.ts/ }))

    // One in the collapsed label, one inside the pretty-printed INPUT.
    expect(container.querySelectorAll('[data-path-button]')).toHaveLength(2)
    // Everything else in the JSON stays text.
    expect(screen.getByText(/"old_string"/)).toBeInTheDocument()

    fireEvent.click(container.querySelectorAll('[data-path-button]')[1])
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: '/a/b/store.ts', line: null })
  })

  it('supports notebook_path on NotebookEdit', () => {
    const { container } = render(
      <ToolRow
        toolUse={makeToolUse({ id: 't1', toolName: 'NotebookEdit', toolInput: { notebook_path: '/n/b.py' } })}
      />
    )
    const button = container.querySelector('[data-path-button]')!
    fireEvent.click(button)
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: '/n/b.py', line: null })
  })

  it('leaves image and binary extensions as plain text', () => {
    const { container } = render(
      <ToolRow toolUse={makeToolUse({ id: 't1', toolName: 'Read', toolInput: { file_path: '/shots/map.png' } })} />
    )
    expect(container.querySelector('[data-path-button]')).toBeNull()
    expect(screen.getByRole('button', { name: /Read: \/shots\/map\.png/ })).toBeInTheDocument()
  })
})

describe('MessageView: pressable prose paths', () => {
  beforeEach(() => {
    useOrbital.setState((s) => ({ ui: { ...s.ui, fileViewer: null } }))
  })

  it('turns an assistant-prose path with a line into a path button', () => {
    const { container } = render(
      <MessageView message={makeMessage({ id: '1', text: 'the fix is in web/src/App.tsx:42, honest' })} />
    )

    const button = container.querySelector('[data-path-button]')!
    expect(button).toHaveTextContent('web/src/App.tsx:42')

    fireEvent.click(button)
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: 'web/src/App.tsx', line: 42 })
  })

  it('never touches paths inside code spans or fenced blocks', () => {
    const text = 'use `web/src/App.tsx` and\n\n```\ndocs/readme.md\n```'
    const { container } = render(<MessageView message={makeMessage({ id: '1', text })} />)
    expect(container.querySelector('[data-path-button]')).toBeNull()
  })

  it('leaves user turns alone', () => {
    const { container } = render(
      <MessageView message={makeMessage({ id: '1', role: 'user', text: 'look at web/src/App.tsx:42' })} />
    )
    expect(container.querySelector('[data-path-button]')).toBeNull()
  })

  it('leaves authored markdown links as plain anchors', () => {
    const { container } = render(
      <MessageView message={makeMessage({ id: '1', text: '[notes](https://example.com/a.md)' })} />
    )
    const anchor = container.querySelector('a')!
    expect(anchor).toHaveAttribute('href', 'https://example.com/a.md')
    expect(container.querySelector('[data-path-button]')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

import {
  Transcript,
  pairMessages,
  groupToolRuns,
  insertModelDividers,
} from '../panels/Transcript'

// `isNearBottom` and `compensatePrepend` moved to `panels/transcriptMotion`
// with the rest of the scroll logic; they are tested in
// `transcriptmotion.test.ts`.

describe('pairMessages', () => {
  it('pairs a tool_use with its tool_result by toolUseId and folds them into one item', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', text: 'run the tests' },
      { id: '2', role: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'tu1' },
      { id: '3', role: 'tool_result', toolUseId: 'tu1', text: 'PASS' },
      { id: '4', role: 'assistant', text: 'tests passed' },
    ]

    const items = pairMessages(messages)

    expect(items).toHaveLength(3)
    expect(items.map((i) => i.kind)).toEqual(['message', 'tool', 'message'])
    const toolItem = items[1]
    if (toolItem.kind !== 'tool') throw new Error('expected tool item')
    expect(toolItem.toolUse.id).toBe('2')
    expect(toolItem.toolResult?.id).toBe('3')
  })

  it('preserves original relative order across interleaved message kinds', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', text: 'a' },
      { id: '2', role: 'assistant', text: 'b' },
      { id: '3', role: 'tool_use', toolName: 'Bash', toolInput: { command: 'x' }, toolUseId: 'tu1' },
      { id: '4', role: 'tool_result', toolUseId: 'tu1', text: 'y' },
      { id: '5', role: 'assistant', text: 'c' },
    ]

    const items = pairMessages(messages)
    expect(items.map((i) => i.key)).toEqual(['1', '2', '3', '5'])
  })

  it('groups only *consecutive* tool rows, leaving messages as their own rows', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', text: 'a' },
      { id: '2', role: 'tool_use', toolName: 'Read', toolInput: { file_path: '/a.ts' }, toolUseId: 'tu1' },
      { id: '3', role: 'tool_use', toolName: 'Bash', toolInput: { command: 'x' }, toolUseId: 'tu2' },
      { id: '4', role: 'assistant', text: 'b' },
      { id: '5', role: 'tool_use', toolName: 'Bash', toolInput: { command: 'y' }, toolUseId: 'tu3' },
    ]

    const groups = groupToolRuns(pairMessages(messages))

    expect(groups.map((g) => g.kind)).toEqual(['message', 'tools', 'message', 'tools'])
    expect(groups.map((g) => (g.kind === 'tools' ? g.items.length : 1))).toEqual([1, 2, 1, 1])
    // Keys stay stable per group (first item of the run).
    expect(groups.map((g) => g.key)).toEqual(['1', '2', '4', '5'])
  })

  it('gives an AskUserQuestion call a group of its own, and breaks the run around it', () => {
    // Spec 2026-09-20-interactive-decisions-design: a question is not machine
    // work to be folded away — the folding rules must never be able to reach
    // it, which is what being its own group kind buys.
    const messages: ChatMessage[] = [
      { id: '1', role: 'tool_use', toolName: 'Read', toolInput: {}, toolUseId: 'tu1' },
      { id: '2', role: 'tool_use', toolName: 'Bash', toolInput: {}, toolUseId: 'tu2' },
      {
        id: '3',
        role: 'tool_use',
        toolName: 'AskUserQuestion',
        toolInput: { questions: [] },
        toolUseId: 'tu3',
      },
      { id: '4', role: 'tool_use', toolName: 'Bash', toolInput: {}, toolUseId: 'tu4' },
    ]

    const groups = groupToolRuns(pairMessages(messages))

    expect(groups.map((g) => g.kind)).toEqual(['tools', 'question', 'tools'])
    expect(groups.map((g) => g.key)).toEqual(['1', '3', '4'])
  })

  it('never folds two question cards together', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'tool_use',
        toolName: 'AskUserQuestion',
        toolInput: { questions: [] },
        toolUseId: 'tu1',
      },
      {
        id: '2',
        role: 'tool_use',
        toolName: 'AskUserQuestion',
        toolInput: { questions: [] },
        toolUseId: 'tu2',
      },
    ]
    expect(groupToolRuns(pairMessages(messages)).map((g) => g.kind)).toEqual([
      'question',
      'question',
    ])
  })

  // Permission prompts and plan approvals (spec:
  // 2026-09-23-permission-and-plan-decisions-design § Web UI).

  it('always lifts ExitPlanMode out of a run — a plan stays worth reading', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'tool_use', toolName: 'Read', toolInput: {}, toolUseId: 'tu1' },
      {
        id: '2',
        role: 'tool_use',
        toolName: 'ExitPlanMode',
        toolInput: { plan: '# Plan' },
        toolUseId: 'tu2',
      },
      { id: '3', role: 'tool_use', toolName: 'Read', toolInput: {}, toolUseId: 'tu3' },
    ]
    // No pending decision at all: the plan is a card from its own history.
    expect(groupToolRuns(pairMessages(messages)).map((g) => g.kind)).toEqual([
      'tools',
      'decision',
      'tools',
    ])
  })

  it('lifts the tool the session is parked on, and only while it is parked', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'tool_use', toolName: 'Bash', toolInput: {}, toolUseId: 'tu1' },
      { id: '2', role: 'tool_use', toolName: 'Bash', toolInput: {}, toolUseId: 'tu2' },
    ]
    const items = pairMessages(messages)
    expect(groupToolRuns(items, 'tu2').map((g) => g.kind)).toEqual(['tools', 'decision'])
    // Settled: the CLI records the tool call, never the prompt, so there is
    // nothing left to draw a card from and the run folds as usual.
    expect(groupToolRuns(items).map((g) => g.kind)).toEqual(['tools'])
  })

  it('a parked AskUserQuestion is still a question card, not a permission one', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'tool_use',
        toolName: 'AskUserQuestion',
        toolInput: { questions: [] },
        toolUseId: 'tu1',
      },
    ]
    expect(groupToolRuns(pairMessages(messages), 'tu1').map((g) => g.kind)).toEqual(['question'])
  })

  it('leaves a tool_use with no matching tool_result as a running item', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'tool_use', toolName: 'Bash', toolInput: { command: 'x' }, toolUseId: 'tu1' },
    ]
    const items = pairMessages(messages)
    expect(items).toHaveLength(1)
    if (items[0].kind !== 'tool') throw new Error('expected tool item')
    expect(items[0].toolResult).toBeUndefined()
  })
})

const assistant = (id: string, model?: string, timestamp?: string): ChatMessage => ({
  id, role: 'assistant', text: `m-${id}`, model, timestamp,
})

describe('insertModelDividers', () => {
  const groupsOf = (messages: ChatMessage[]) => groupToolRuns(pairMessages(messages))

  it('marks a change between two assistant messages', () => {
    const groups = insertModelDividers(
      groupsOf([
        assistant('a1', 'claude-sonnet-5'),
        assistant('a2', 'claude-opus-5', '2026-09-16T14:02:00Z'),
      ]),
    )
    const divider = groups.find((g) => g.kind === 'model-divider')
    expect(divider).toMatchObject({ from: 'claude-sonnet-5', to: 'claude-opus-5' })
    expect(groups.indexOf(divider!)).toBe(1)
  })

  it('adds nothing when the model never changes', () => {
    const groups = insertModelDividers(
      groupsOf([assistant('a1', 'claude-opus-5'), assistant('a2', 'claude-opus-5')]),
    )
    expect(groups.some((g) => g.kind === 'model-divider')).toBe(false)
  })

  it('ignores messages with no model and user turns', () => {
    const groups = insertModelDividers(
      groupsOf([
        assistant('a1', 'claude-sonnet-5'),
        { id: 'u1', role: 'user', text: 'and now?' },
        assistant('a2'),
        assistant('a3', 'claude-sonnet-5'),
      ]),
    )
    expect(groups.some((g) => g.kind === 'model-divider')).toBe(false)
  })

  it('does not mark the first model it sees', () => {
    const groups = insertModelDividers(groupsOf([assistant('a1', 'claude-opus-5')]))
    expect(groups.some((g) => g.kind === 'model-divider')).toBe(false)
  })
})

it('renders the divider in the transcript', () => {
  renderTranscript([
    assistant('a1', 'claude-sonnet-5'),
    assistant('a2', 'claude-opus-5', '2026-09-16T14:02:00Z'),
  ])
  expect(screen.getByText(/claude-sonnet-5 → claude-opus-5/i)).toBeInTheDocument()
})

it('names the divider through the catalog when it knows both models', () => {
  const models: OrbitalModel[] = [
    {
      value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'sonnet', version: '5',
      shortVersion: 'Sonnet 5', variant: null, blurb: '', contextWindow: 200_000,
    },
    {
      value: 'opus', resolvedModel: 'claude-opus-5', family: 'opus', version: '5',
      shortVersion: 'Opus 5', variant: null, blurb: '', contextWindow: 1_000_000,
    },
  ]
  resetStore({
    transcripts: {
      s1: [
        assistant('a1', 'claude-sonnet-5'),
        assistant('a2', 'claude-opus-5', '2026-09-16T14:02:00Z'),
      ],
    },
    models,
  })

  render(<Transcript sessionId="s1" />)

  expect(screen.getByText(/sonnet 5 → opus 5/i)).toBeInTheDocument()
})

it('falls back to the raw resolved id when the catalog has no matching model', () => {
  resetStore({
    transcripts: {
      s1: [
        assistant('a1', 'claude-sonnet-5'),
        assistant('a2', 'claude-opus-5', '2026-09-16T14:02:00Z'),
      ],
    },
    models: [],
  })

  render(<Transcript sessionId="s1" />)

  expect(screen.getByText(/claude-sonnet-5 → claude-opus-5/i)).toBeInTheDocument()
})

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

const defaultUi: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  wsStatus: 'connected',
  dialog: null,
  sidebarCollapsed: false,
  fileViewer: null,
}

function resetStore(
  overrides: Partial<Omit<OrbitalState, 'ui'>> & { ui?: Partial<OrbitalUiState> } = {}
) {
  useOrbital.setState({
    sessions: {},
    order: [],
    tags: [],
    rules: [],
    settings: {},
    transcripts: {},
    historyLoaded: {},
    transcriptErrors: {},
    errors: [],
    errorsUnseen: 0,
    toast: null,
    ...overrides,
    ui: { ...defaultUi, ...overrides.ui },
  })
}

function makeError(overrides: Partial<ErrorRecord> & { id: number }): ErrorRecord {
  return {
    at: 1_700_000_000_000,
    source: 'server',
    kind: 'session_failed',
    sessionId: null,
    message: 'spawn claude ENOENT',
    detail: null,
    context: null,
    seenAt: null,
    ...overrides,
  }
}

/** Puts `messages` in session `s1`'s transcript and renders it — shared by
 * the divider render test above and the `Transcript` suite below. */
function renderTranscript(messages: ChatMessage[]) {
  resetStore({ transcripts: { s1: messages } })
  return render(<Transcript sessionId="s1" />)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('Transcript', () => {
  it('renders messages for a session, pairing tool calls with their results', () => {
    resetStore({
      transcripts: {
        s1: [
          { id: '1', role: 'user', text: 'run the tests' },
          { id: '2', role: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'tu1' },
          { id: '3', role: 'tool_result', toolUseId: 'tu1', text: 'PASS' },
        ],
      },
    })

    render(<Transcript sessionId="s1" />)

    expect(screen.getByText('run the tests')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Bash: npm test/ })).toBeInTheDocument()
    // The tool_result is folded into the ToolRow, not rendered as its own
    // top-level message bubble.
    expect(screen.queryByText('PASS')).not.toBeInTheDocument()
  })

  it('renders an error row when the store flags the session as crashed (task 14 error state)', () => {
    resetStore({
      transcripts: { s1: [{ id: '1', role: 'user', text: 'go' }] },
      transcriptErrors: { s1: true },
    })

    render(<Transcript sessionId="s1" />)

    expect(screen.getByRole('alert')).toHaveTextContent(/ended unexpectedly/i)
  })

  it('prints the recorded reason instead of the guess when the log has a row for the session', () => {
    resetStore({
      transcripts: { s1: [{ id: '1', role: 'user', text: 'go' }] },
      transcriptErrors: { s1: true },
      errors: [makeError({ id: 1, sessionId: 's1', message: 'spawn claude ENOENT' })],
    })

    render(<Transcript sessionId="s1" />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('spawn claude ENOENT')
    expect(alert).not.toHaveTextContent(/ended unexpectedly/i)
    // …and a way through to the full record.
    expect(within(alert).getByRole('button', { name: /detail/i })).toBeInTheDocument()
  })

  it('prefers the most recent record when the session has more than one', () => {
    resetStore({
      transcripts: { s1: [{ id: '1', role: 'user', text: 'go' }] },
      // Newest first, the order the log is held in.
      errors: [
        makeError({ id: 2, sessionId: 's1', message: 'the latest failure' }),
        makeError({ id: 1, sessionId: 's1', message: 'an older failure' }),
      ],
    })

    render(<Transcript sessionId="s1" />)

    expect(screen.getByRole('alert')).toHaveTextContent('the latest failure')
  })

  it('falls back to the heuristic sentence when the log holds nothing for this session', () => {
    resetStore({
      transcripts: { s1: [{ id: '1', role: 'user', text: 'go' }] },
      transcriptErrors: { s1: true },
      // A record, but for a different session — a CLI that exits non-zero
      // without the generator throwing records nothing at all.
      errors: [makeError({ id: 1, sessionId: 's2', message: 'spawn claude ENOENT' })],
    })

    render(<Transcript sessionId="s1" />)

    expect(screen.getByRole('alert')).toHaveTextContent(/ended unexpectedly/i)
  })

  it('opens the error log from the recorded row’s Detail button', async () => {
    const user = userEvent.setup()
    resetStore({
      transcripts: { s1: [{ id: '1', role: 'user', text: 'go' }] },
      errors: [makeError({ id: 1, sessionId: 's1' })],
    })

    render(<Transcript sessionId="s1" />)
    await user.click(screen.getByRole('button', { name: /detail/i }))

    expect(useOrbital.getState().ui.dialog).toBe('errors')
  })

  it('does not render an error row for a session without the crashed flag', () => {
    resetStore({
      transcripts: { s1: [{ id: '1', role: 'user', text: 'go' }] },
      transcriptErrors: { s2: true },
    })

    render(<Transcript sessionId="s1" />)

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders a "Load older" button that calls the store\'s loadOlder with the session id', async () => {
    const user = userEvent.setup()
    const loadOlderSpy = vi.fn().mockResolvedValue([])
    resetStore({
      transcripts: {
        s1: [{ id: '5', role: 'user', text: 'hello' }],
      },
    })
    useOrbital.setState({ loadOlder: loadOlderSpy })

    render(<Transcript sessionId="s1" />)
    await user.click(screen.getByRole('button', { name: /load older/i }))

    expect(loadOlderSpy).toHaveBeenCalledWith('s1')
  })

  it('prepends older messages returned by loadOlder while keeping existing ones in place', async () => {
    const user = userEvent.setup()
    resetStore({
      transcripts: {
        s1: [{ id: '5', role: 'user', text: 'newer message' }],
      },
    })
    const loadOlderSpy = vi.fn().mockImplementation(async (id: string) => {
      const older: ChatMessage = { id: '1', role: 'user', text: 'older message' }
      useOrbital.setState((state) => ({
        transcripts: { ...state.transcripts, [id]: [older, ...state.transcripts[id]] },
      }))
      return [older]
    })
    useOrbital.setState({ loadOlder: loadOlderSpy })

    render(<Transcript sessionId="s1" />)
    await user.click(screen.getByRole('button', { name: /load older/i }))

    expect(await screen.findByText('older message')).toBeInTheDocument()
    expect(screen.getByText('newer message')).toBeInTheDocument()
  })

  it('grows the visible window so newly loaded older messages actually appear (regression: window used to stay pinned to the last 200 raw messages, hiding anything loadOlder prepended)', async () => {
    const user = userEvent.setup()
    // The realistic steady state: exactly the window size already stored
    // and visible (the server caps the initial select() fetch at 100 —
    // see server/src/api/routes.ts — well under the 200-item window, so
    // nothing is hidden yet when the first "load older" click happens).
    const initial: ChatMessage[] = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      role: 'user',
      text: `message ${i}`,
    }))
    resetStore({ transcripts: { s1: initial } })

    render(<Transcript sessionId="s1" />)
    expect(screen.getByText('message 0')).toBeInTheDocument()

    const older: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      id: `older${i}`,
      role: 'user',
      text: `older message ${i}`,
    }))
    const loadOlderSpy = vi.fn().mockImplementation(async (id: string) => {
      useOrbital.setState((state) => ({
        transcripts: { ...state.transcripts, [id]: [...older, ...state.transcripts[id]] },
      }))
      return older
    })
    act(() => {
      useOrbital.setState({ loadOlder: loadOlderSpy })
    })

    await user.click(screen.getByRole('button', { name: /load older/i }))

    // The newly prepended page must actually render, not just sit in the
    // store while the window stays pinned to its old size.
    expect(await screen.findByText('older message 0')).toBeInTheDocument()
    expect(screen.getByText('older message 49')).toBeInTheDocument()
  })

  it('grows the window by exactly the fetched page size, not by collapsing to the full stored history (bounded growth)', async () => {
    const user = userEvent.setup()
    // A backlog already sits beyond the window before any click (260
    // stored, 200-item window -> the oldest 60 are hidden). A single
    // "load older" click should grow the window by only the newly
    // fetched page's size (5), not jump straight to showing everything
    // ever stored.
    const initial: ChatMessage[] = Array.from({ length: 260 }, (_, i) => ({
      id: `m${i}`,
      role: 'user',
      text: `message ${i}`,
    }))
    resetStore({ transcripts: { s1: initial } })

    render(<Transcript sessionId="s1" />)
    expect(screen.queryByText('message 0')).not.toBeInTheDocument()

    const loadOlderSpy = vi.fn().mockImplementation(async (id: string) => {
      const extra: ChatMessage[] = Array.from({ length: 5 }, (_, i) => ({
        id: `extra${i}`,
        role: 'user',
        text: `extra ${i}`,
      }))
      useOrbital.setState((state) => ({
        transcripts: { ...state.transcripts, [id]: [...extra, ...state.transcripts[id]] },
      }))
      return extra
    })
    act(() => {
      useOrbital.setState({ loadOlder: loadOlderSpy })
    })

    await user.click(screen.getByRole('button', { name: /load older/i }))

    // 260 (pre-existing backlog beyond the window) + 5 (freshly fetched) =
    // 265 total; window grows from 200 to 205. With the 5 extras prepended
    // in front, the cutoff (still 60 items from the end of whatever's
    // hidden) now lands 5 messages later into the original backlog:
    // "message 55" through "message 59" become newly visible, but
    // "message 54" and earlier, and the freshly fetched "extra*" messages,
    // stay hidden — proving the window grew by exactly the fetched page's
    // size (5), not by 60+5 (which a total-collapsing formula would have
    // revealed all of, including the extras).
    await waitFor(() => {
      expect(screen.getByText('message 55')).toBeInTheDocument()
    })
    expect(screen.queryByText('message 54')).not.toBeInTheDocument()
    expect(screen.queryByText('extra 0')).not.toBeInTheDocument()
    expect(screen.queryByText('extra 4')).not.toBeInTheDocument()
  })

  it('hides the "Load older" button once loadOlder reports an empty page', async () => {
    const user = userEvent.setup()
    resetStore({ transcripts: { s1: [{ id: '1', role: 'user', text: 'only message' }] } })
    useOrbital.setState({ loadOlder: vi.fn().mockResolvedValue([]) })

    render(<Transcript sessionId="s1" />)
    await user.click(screen.getByRole('button', { name: /load older/i }))

    expect(await screen.findByText('only message')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /load older/i })).not.toBeInTheDocument()
  })

  it('keeps a tool_use visible together with its tool_result even though raw-message windowing alone would split them (regression: pairing must happen on the full array before windowing)', () => {
    // 201 raw messages: a tool_use+tool_result pair (2 raw messages) at the
    // very front, followed by 199 plain messages. Windowing the RAW array
    // to the last 200 would drop the tool_use (index 0) while keeping the
    // now-orphaned tool_result (index 1) — which the old pair-after-window
    // code silently discarded entirely, losing the whole tool call from
    // view. Pairing first collapses the pair into a single atomic item
    // before windowing ever runs, so it can only be shown or hidden whole.
    const plain: ChatMessage[] = Array.from({ length: 199 }, (_, i) => ({
      id: `p${i}`,
      role: 'user',
      text: `plain ${i}`,
    }))
    const messages: ChatMessage[] = [
      { id: 'tu', role: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'tu1' },
      { id: 'tr', role: 'tool_result', toolUseId: 'tu1', text: 'PASS' },
      ...plain,
    ]
    resetStore({ transcripts: { s1: messages } })

    render(<Transcript sessionId="s1" />)

    expect(screen.getByRole('button', { name: /Bash: npm test/ })).toBeInTheDocument()
  })

  it('blinks a caret after the last assistant turn while the session is working, and nowhere else (canvas 1b)', () => {
    const transcripts = {
      s1: [
        { id: '1', role: 'user', text: 'go' } as ChatMessage,
        { id: '2', role: 'assistant', text: 'working on it' } as ChatMessage,
      ],
    }
    resetStore({
      transcripts,
      sessions: {
        s1: {
          id: 's1',
          cwd: '/tmp',
          title: 's1',
          firstAt: 1,
          lastAt: 2,
          messageCount: 2,
          source: 'web',
          permissionMode: null,
          model: null,
          resolvedModel: null,
          parentId: null,
          mapDismissedAt: null,
          tagIds: [],
          status: 'working',
          subagents: [],
        },
      },
    })

    const { container, rerender } = render(<Transcript sessionId="s1" />)
    expect(container.querySelectorAll('[data-streaming-caret]')).toHaveLength(1)
    expect(
      container.querySelector('[data-role="assistant"] [data-streaming-caret]')
    ).toBeInTheDocument()

    // Turn finished -> the caret goes away.
    act(() => {
      useOrbital.setState((state) => ({
        sessions: { s1: { ...state.sessions.s1, status: 'idle' } },
      }))
    })
    rerender(<Transcript sessionId="s1" />)
    expect(container.querySelector('[data-streaming-caret]')).not.toBeInTheDocument()
  })

  it('packs consecutive tool calls into one run, folded behind a header (canvas 1b + 6b)', () => {
    resetStore({
      transcripts: {
        s1: [
          { id: '1', role: 'user', text: 'run the tests' },
          { id: '2', role: 'tool_use', toolName: 'Read', toolInput: { file_path: '/a.ts' }, toolUseId: 'tu1' },
          { id: '3', role: 'tool_result', toolUseId: 'tu1', text: 'contents' },
          { id: '4', role: 'tool_use', toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'tu2' },
          { id: '5', role: 'assistant', text: 'done' },
        ],
      },
    })

    const { container } = render(<Transcript sessionId="s1" />)

    const runs = container.querySelectorAll('[data-tool-run]')
    expect(runs).toHaveLength(1)
    // Folded by default: no openable ToolRows, one header, and — because
    // tu2 has no result yet — the live trace beneath it.
    expect(runs[0].querySelectorAll('[data-role="tool"]')).toHaveLength(0)
    expect(screen.getByRole('button', { name: /2 tool calls/ })).toBeInTheDocument()
    expect(runs[0].querySelector('[data-live-tool]')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Folding (spec: 2026-09-18-transcript-folding-design)
// ---------------------------------------------------------------------------

import { summarizeToolRun } from '../panels/Transcript'

describe('summarizeToolRun', () => {
  const use = (id: string, name: string) => ({
    kind: 'tool' as const,
    key: id,
    toolUse: makeToolUse({ id, toolName: name }),
    toolResult: makeToolResult({ id: `${id}r`, toolUseId: id }),
  })

  it('counts calls and sorts kinds by count desc, then first appearance', () => {
    const s = summarizeToolRun([
      use('1', 'Bash'), use('2', 'Read'), use('3', 'Read'),
      use('4', 'Edit'), use('5', 'Read'), use('6', 'Bash'),
    ])
    expect(s.count).toBe(6)
    expect(s.breakdown).toBe('Read ×3, Bash ×2, Edit')
  })

  it('names the top three kinds and appends +n more beyond that', () => {
    const s = summarizeToolRun([
      use('1', 'Read'), use('2', 'Read'), use('3', 'Bash'), use('4', 'Bash'),
      use('5', 'Edit'), use('6', 'Write'), use('7', 'Grep'),
    ])
    expect(s.breakdown).toBe('Read ×2, Bash ×2, Edit +2 more')
  })
})

describe('Transcript: folded tool runs', () => {
  const run = (n: number, opts: { unfinishedLast?: boolean; failFirst?: boolean } = {}) => {
    const messages: ChatMessage[] = [{ id: 'u', role: 'user', text: 'go' }]
    for (let i = 1; i <= n; i += 1) {
      messages.push({ id: `t${i}`, role: 'tool_use', toolName: i % 2 ? 'Read' : 'Bash', toolInput: { file_path: `f${i}` }, toolUseId: `tu${i}` })
      if (!(opts.unfinishedLast && i === n)) {
        messages.push({ id: `r${i}`, role: 'tool_result', toolUseId: `tu${i}`, text: 'ok', ...(opts.failFirst && i === 1 ? { isError: true } : {}) })
      }
    }
    return messages
  }

  it('folds 2+ consecutive calls behind a header and hides the rows', () => {
    renderTranscript(run(3))
    const header = screen.getByRole('button', { name: /3 tool calls/ })
    expect(header).toHaveTextContent('Read ×2, Bash')
    expect(screen.queryByRole('button', { name: /Read: f1/ })).not.toBeInTheDocument()
  })

  it('a single call keeps today\'s row — no header', () => {
    renderTranscript(run(1))
    expect(screen.queryByText(/tool calls/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Read: f1/ })).toBeInTheDocument()
  })

  it('clicking the header expands today\'s full stack, clicking again folds it', async () => {
    renderTranscript(run(3))
    const header = screen.getByRole('button', { name: /3 tool calls/ })
    fireEvent.click(header)
    expect(screen.getByRole('button', { name: /Read: f1/ })).toBeInTheDocument()
    fireEvent.click(header)
    // Awaited, not immediate: the stack is held mounted while it collapses
    // (see FOLD_MS) and only then removed. What matters is that a folded run
    // ends up holding no rows at all — the duration is not asserted.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Read: f1/ })).not.toBeInTheDocument()
    )
  })

  it('a live run stays folded with the one unfinished call visible beneath the header', () => {
    renderTranscript(run(3, { unfinishedLast: true }))
    const header = screen.getByRole('button', { name: /3 tool calls/ })
    expect(header).toHaveTextContent('running')
    // The unfinished row is a plain trace, not an openable ToolRow. (The
    // salient path sits in its own span, so it's the single-node target.)
    expect(screen.getByText('f3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Read: f3/ })).not.toBeInTheDocument()
    // The finished calls stay folded into the count.
    expect(screen.queryByText('f1')).not.toBeInTheDocument()
  })

  it('a run containing a failed call opens itself and says n failed — but a manual toggle wins', async () => {
    renderTranscript(run(2, { failFirst: true }))
    const header = screen.getByRole('button', { name: /2 tool calls/ })
    expect(header).toHaveTextContent('1 failed')
    expect(screen.getByRole('button', { name: /Read: f1/ })).toBeInTheDocument()
    fireEvent.click(header)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Read: f1/ })).not.toBeInTheDocument()
    )
  })

  it('a call that fails while you watch does not throw the run open', async () => {
    // The default is frozen at the group's first render. A failure landing
    // after that says so in the right slot and leaves the fold alone —
    // otherwise the run pops open under the reader and shoves the rest of
    // the transcript down the page.
    const { rerender } = renderTranscript(run(2, { unfinishedLast: true }))
    expect(screen.getByRole('button', { name: /2 tool calls/ })).toHaveTextContent('running')

    act(() => {
      useOrbital.setState((s) => ({
        transcripts: {
          ...s.transcripts,
          s1: [...s.transcripts.s1, { id: 'r2', role: 'tool_result', toolUseId: 'tu2', text: 'boom', isError: true }],
        },
      }))
    })
    rerender(<Transcript sessionId="s1" />)

    const header = screen.getByRole('button', { name: /2 tool calls/ })
    expect(header).toHaveTextContent('1 failed')
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /Read: f1/ })).not.toBeInTheDocument()
  })
})

describe('MessageView: folded command expansion', () => {
  const command = { name: '/code-review', body: '<command-contents>You are reviewing.\nRead the diff.</command-contents>', blocks: 2 }

  it('renders the human text as the bubble and the expansion as a chip', () => {
    const { container } = render(
      <MessageView message={makeMessage({ id: '1', role: 'user', text: 'look here', command })} />
    )
    expect(screen.getByText('look here')).toBeInTheDocument()
    const chip = screen.getByRole('button', { name: /\/code-review/ })
    expect(chip).toHaveTextContent('2 lines')
    expect(container.querySelector('pre')).not.toBeInTheDocument()
  })

  it('typed nothing → the chip stands alone, no empty bubble', () => {
    const { container } = render(
      <MessageView message={makeMessage({ id: '1', role: 'user', text: '', command })} />
    )
    expect(screen.getByRole('button', { name: /\/code-review/ })).toBeInTheDocument()
    expect(container.querySelector('[data-role="user"] .markdown, [data-role="user"] p')).not.toBeInTheDocument()
  })

  it('expanding shows the body verbatim in a <pre>, never as markdown', () => {
    const { container } = render(
      <MessageView message={makeMessage({ id: '1', role: 'user', text: 'go', command })} />
    )
    fireEvent.click(screen.getByRole('button', { name: /\/code-review/ }))
    const pre = container.querySelector('pre')
    expect(pre).toBeInTheDocument()
    expect(pre?.textContent).toContain('<command-contents>')
    expect(pre?.textContent).toContain('You are reviewing.')
  })

  it('an unnamed injection reads machine context, with ×n for multiple blocks', () => {
    render(
      <MessageView
        message={makeMessage({
          id: '1', role: 'user', text: 'try again',
          command: { name: null, body: '<system-reminder>a</system-reminder>\n<system-reminder>b</system-reminder>', blocks: 2 },
        })}
      />
    )
    expect(screen.getByRole('button', { name: /machine context ×2/ })).toBeInTheDocument()
  })
})

describe('a turn nobody authored sits on the agent side', () => {
  const machineOnly = {
    id: '1', role: 'user' as const, text: '',
    command: { name: null, body: '<task-notification>a</task-notification>', blocks: 1 },
  }

  it('aligns a machine-context-only turn left, like the agent speaking', () => {
    // A resumed session's task notifications arrive as user-role turns the
    // human never typed (spec 2026-09-21-session-autoheal-design). Showing
    // them right-aligned puts the CLI's words in the user's voice.
    const { container } = render(<MessageView message={makeMessage(machineOnly)} />)
    expect(container.firstElementChild?.className).toContain('items-start')
    expect(container.firstElementChild?.className).not.toContain('items-end')
  })

  it('keeps a turn the human did type on the right, chip and all', () => {
    const { container } = render(
      <MessageView message={makeMessage({ ...machineOnly, text: 'carry on' })} />
    )
    expect(container.firstElementChild?.className).toContain('items-end')
  })

  it('still marks it a user turn, only its placement changes', () => {
    const { container } = render(<MessageView message={makeMessage(machineOnly)} />)
    expect(container.querySelector('[data-role="user"]')).toBeInTheDocument()
  })
})
