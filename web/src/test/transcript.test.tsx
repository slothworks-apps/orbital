import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ChatMessage } from '../lib/types'
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

  it('renders a fenced code block with no language as block-level markup, not inline code styling', () => {
    const text = '```\nplain block\n```'
    const { container } = render(<MessageView message={makeMessage({ id: '1', text })} />)

    const pre = container.querySelector('pre')
    expect(pre).toBeInTheDocument()
    expect(pre?.textContent).toContain('plain block')
    // Block-level styling (matches CodeBlock's own pending-state fallback),
    // not the inline `code` chip styling (bg-white/10 px-1 py-0.5).
    expect(pre?.className).toContain('bg-black/30')
    expect(pre?.querySelector('code')?.className ?? '').not.toContain('bg-white/10')
  })

  it('marks the role via data-role, distinguishing user from assistant styling', () => {
    const { container: userContainer } = render(
      <MessageView message={makeMessage({ id: '1', role: 'user', text: 'hi' })} />
    )
    const { container: assistantContainer } = render(
      <MessageView message={makeMessage({ id: '2', role: 'assistant', text: 'hi' })} />
    )
    expect(userContainer.querySelector('[data-role="user"]')).toBeInTheDocument()
    expect(assistantContainer.querySelector('[data-role="assistant"]')).toBeInTheDocument()
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
  it('shows a collapsed one-liner with the tool name and salient input', () => {
    render(<ToolRow toolUse={makeToolUse({ id: 't1', toolName: 'Bash', toolInput: { command: 'npm test' } })} />)
    expect(screen.getByText('⚙')).toBeInTheDocument()
    expect(screen.getByText('Bash: npm test')).toBeInTheDocument()
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
// Transcript
// ---------------------------------------------------------------------------

import { Transcript, pairMessages, isNearBottom, compensatePrepend } from '../panels/Transcript'

describe('isNearBottom', () => {
  it('is true when the bottom of the content is within the threshold', () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
    expect(isNearBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 }, 80)).toBe(true)
  })

  it('is false when scrolled well away from the bottom', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 })).toBe(false)
  })
})

describe('compensatePrepend', () => {
  it('grows scrollTop by exactly the amount the container grew, keeping the same content anchored', () => {
    // Container grew by 300px (older content prepended above); scrollTop
    // must grow by the same 300px so the pixel that was at the top stays there.
    expect(compensatePrepend(1000, 1300, 400)).toBe(700)
  })

  it('is a no-op when the container did not grow', () => {
    expect(compensatePrepend(1000, 1000, 400)).toBe(400)
  })
})

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

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ApiError: actual.ApiError,
    api: {
      listSessions: vi.fn(),
      getSession: vi.fn(),
      getMessages: vi.fn(),
      sendMessage: vi.fn(),
      listTags: vi.fn(),
      listTagRules: vi.fn(),
      getSettings: vi.fn(),
      createSession: vi.fn(),
      interrupt: vi.fn(),
      clearSession: vi.fn(),
      renameSession: vi.fn(),
      setSessionTags: vi.fn(),
      createTag: vi.fn(),
      patchTag: vi.fn(),
      deleteTag: vi.fn(),
      createTagRule: vi.fn(),
      patchTagRule: vi.fn(),
      deleteTagRule: vi.fn(),
      previewRule: vi.fn(),
      listProjects: vi.fn(),
      patchSettings: vi.fn(),
    } satisfies Record<keyof typeof actual.api, unknown>,
  }
})

const defaultUi: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  wsStatus: 'connected',
  dialog: null,
  sidebarCollapsed: false,
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
    subagents: {},
    usage: {},
    historyLoaded: {},
    transcriptErrors: {},
    toast: null,
    ...overrides,
    ui: { ...defaultUi, ...overrides.ui },
  })
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
    expect(screen.getByText('Bash: npm test')).toBeInTheDocument()
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

    expect(screen.getByText('Bash: npm test')).toBeInTheDocument()
  })
})
