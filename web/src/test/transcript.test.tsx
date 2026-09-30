import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
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

  it('copies a fenced block as its source text — not the highlighted markup, not the fence', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const text = 'before\n\n```ts\nconst a = 1\nconst b = 2\n```\n\n```\nplain block\n```'
    const { container } = render(<MessageView message={makeMessage({ id: '1', text })} />)
    await waitFor(() => expect(container.querySelector('pre.shiki')).toBeInTheDocument())

    const [highlighted, plain] = screen.getAllByRole('button', { name: /copy code/i })
    await user.click(highlighted)
    await user.click(plain)

    expect(writeText.mock.calls).toEqual([['const a = 1\nconst b = 2'], ['plain block']])
  })

  /**
   * I4. The timestamp under a bubble was interpolated raw — all 24
   * characters of `2026-09-22T10:00:00.000Z`, a full extra line per message
   * in a 380 px panel. Invisible for most of its life, because only the
   * reload path stamped a timestamp at all; task 1 of this branch started
   * stamping the live path too and it became every message everywhere.
   *
   * Asserting the ABSENCE of the ISO string rather than the presence of a
   * particular clock format: the format is the locale's, so pinning it would
   * pin the test runner's locale, but "is not the machine string" can only
   * fail by regression.
   */
  it('renders a timestamp as a clock reading, never as the raw ISO string', () => {
    const timestamp = '2026-09-22T10:00:00.000Z'
    render(<MessageView message={makeMessage({ id: '1', text: 'hi', timestamp })} />)

    expect(screen.queryByText(timestamp)).not.toBeInTheDocument()
    expect(
      screen.getByText(
        new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      )
    ).toBeInTheDocument()
  })

  it('renders nothing at all for a timestamp Date cannot parse — never "Invalid Date"', () => {
    render(<MessageView message={makeMessage({ id: '1', text: 'hi', timestamp: 'not-a-date' })} />)
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument()
    expect(screen.queryByText('not-a-date')).not.toBeInTheDocument()
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
// ThinkingBlock (spec § 7 "Thinking blocks and tool durations")
// ---------------------------------------------------------------------------

import { ThinkingBlock } from '../panels/ThinkingBlock'

function makeThinking(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: 'thinking', text: 'weighing the two approaches', ...overrides }
}

describe('ThinkingBlock', () => {
  it('renders the boxed variant, collapsed by default — the parent transcript', () => {
    const { container } = render(<ThinkingBlock message={makeThinking({ id: 't1' })} />)
    const root = container.querySelector('[data-role="thinking"]')
    expect(root).toHaveAttribute('data-thinking-variant', 'boxed')
    expect(screen.getByRole('button', { name: /thinking/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('weighing the two approaches')).not.toBeInTheDocument()
  })

  it('renders the hairline variant, expanded by default — the compact/subagent-panel treatment', () => {
    const { container } = render(<ThinkingBlock message={makeThinking({ id: 't1' })} compact />)
    const root = container.querySelector('[data-role="thinking"]')
    expect(root).toHaveAttribute('data-thinking-variant', 'compact')
    expect(screen.getByRole('button', { name: /thinking/i })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('weighing the two approaches')).toBeInTheDocument()
  })

  it('toggles the fold in the boxed (default) variant', async () => {
    const user = userEvent.setup()
    render(<ThinkingBlock message={makeThinking({ id: 't1' })} />)
    const button = screen.getByRole('button', { name: /thinking/i })
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('weighing the two approaches')).toBeInTheDocument()
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('weighing the two approaches')).not.toBeInTheDocument()
  })

  it('toggles the fold in the compact variant', async () => {
    const user = userEvent.setup()
    render(<ThinkingBlock message={makeThinking({ id: 't1' })} compact />)
    const button = screen.getByRole('button', { name: /thinking/i })
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('weighing the two approaches')).not.toBeInTheDocument()
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('weighing the two approaches')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// ToolRow
// ---------------------------------------------------------------------------

import { ToolRow, salientInput, toolDurationMs } from '../panels/ToolRow'

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

  it('extracts `description` for Agent too — the current CLI\'s name for the same tool (task 9)', () => {
    expect(salientInput('Agent', { description: 'do the thing', prompt: 'long...' })).toBe('do the thing')
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
  // Two tests below drive the transcript_edit_diffs setting; without this the
  // store carries it into later describes, where a row that arrives open
  // turns their expanding click into a closing one.
  afterEach(() => useOrbital.setState({ settings: {} }))

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

  it('arrives open on an edit when the setting says expanded, and never on a Bash call', () => {
    useOrbital.setState({ settings: { transcript_edit_diffs: 'expanded' } })
    const edit = makeToolUse({
      id: 't1', toolName: 'Edit',
      toolInput: { file_path: '/a.ts', old_string: 'one', new_string: 'two' },
    })
    const { unmount } = render(<ToolRow toolUse={edit} toolResult={makeToolResult({ id: 'r1', toolUseId: 't1', text: 'ok' })} />)
    expect(screen.getByRole('button', { name: /Edit: \/a\.ts/ })).toHaveAttribute(
      'aria-expanded', 'true'
    )
    unmount()

    // The setting is about edit diffs: a tool with no change to show has no
    // business opening itself and dumping its input JSON into the transcript.
    const bash = makeToolUse({ id: 't2', toolName: 'Bash', toolInput: { command: 'npm test' } })
    render(<ToolRow toolUse={bash} toolResult={makeToolResult({ id: 'r2', toolUseId: 't2', text: 'ok' })} />)
    expect(screen.getByRole('button', { name: /Bash: npm test/ })).toHaveAttribute(
      'aria-expanded', 'false'
    )
  })

  it('keeps a hand-toggled row shut when the setting would open it', async () => {
    const user = userEvent.setup()
    useOrbital.setState({ settings: { transcript_edit_diffs: 'expanded' } })
    const edit = makeToolUse({
      id: 't1', toolName: 'Edit',
      toolInput: { file_path: '/a.ts', old_string: 'one', new_string: 'two' },
    })
    render(<ToolRow toolUse={edit} toolResult={makeToolResult({ id: 'r1', toolUseId: 't1', text: 'ok' })} />)
    const row = screen.getByRole('button', { name: /Edit: \/a\.ts/ })

    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'false')

    // A later change to the setting must not reach back and reopen a row the
    // reader deliberately closed.
    useOrbital.setState({ settings: { transcript_edit_diffs: 'expanded' } })
    expect(row).toHaveAttribute('aria-expanded', 'false')
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

  // -------------------------------------------------------------------------
  // Tool durations (spec § 7 "Thinking blocks and tool durations")
  // -------------------------------------------------------------------------

  it('shows the gap between the tool_use and tool_result timestamps (canvas 11b: "· 0.3s")', () => {
    render(
      <ToolRow
        toolUse={makeToolUse({
          id: 't1', toolName: 'Read', toolInput: { file_path: 'eslint.config.js' },
          timestamp: '2026-09-22T10:00:00.000Z',
        })}
        toolResult={makeToolResult({
          id: 'r1', toolUseId: 't1', text: 'ok',
          timestamp: '2026-09-22T10:00:00.300Z',
        })}
      />
    )
    expect(screen.getByText('· 0.3s')).toBeInTheDocument()
  })

  it('renders no duration at all — not "0s" — when either side has no timestamp', () => {
    render(
      <ToolRow
        toolUse={makeToolUse({ id: 't1', toolName: 'Bash', toolInput: { command: 'x' } })}
        toolResult={makeToolResult({ id: 'r1', toolUseId: 't1', text: 'ok', timestamp: '2026-09-22T10:00:00.300Z' })}
      />
    )
    expect(screen.queryByText(/·\s*0s/)).not.toBeInTheDocument()
    expect(screen.queryByText(/^·\s/)).not.toBeInTheDocument()
  })

  it('shows no duration for a tool_use that has not finished yet, even with its own timestamp', () => {
    render(
      <ToolRow
        toolUse={makeToolUse({
          id: 't1', toolName: 'Bash', toolInput: { command: 'x' },
          timestamp: '2026-09-22T10:00:00.000Z',
        })}
      />
    )
    expect(screen.getByTestId('tool-running-dot')).toBeInTheDocument()
    expect(screen.queryByText(/^·\s/)).not.toBeInTheDocument()
  })

  it('treats a reversed pair (tool_result timestamped before its tool_use) as unknown, not a negative-turned-zero duration', () => {
    // A clock adjustment or NTP correction mid-session can land the result's
    // publish timestamp before the call's — this is not a fast call, it is
    // the clock lying, and `Math.max(0, ...)` would have quietly turned that
    // lie into exactly the fabricated 0s the brief forbids.
    expect(
      toolDurationMs(
        makeToolUse({ id: 't1', timestamp: '2026-09-22T10:00:05.000Z' }),
        makeToolResult({ id: 'r1', toolUseId: 't1', timestamp: '2026-09-22T10:00:00.000Z' }),
      )
    ).toBeUndefined()

    render(
      <ToolRow
        toolUse={makeToolUse({
          id: 't2', toolName: 'Bash', toolInput: { command: 'x' },
          timestamp: '2026-09-22T10:00:05.000Z',
        })}
        toolResult={makeToolResult({
          id: 'r2', toolUseId: 't2', text: 'ok',
          timestamp: '2026-09-22T10:00:00.000Z',
        })}
      />
    )
    expect(screen.queryByText(/^·\s/)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Edit diffs (spec: 2026-09-23-edit-diffs-in-the-transcript). The diff itself
// is exercised in diff.test.ts; what is worth a component test is only the
// branch — which body an expanded row opens with.
// ---------------------------------------------------------------------------

describe('ToolRow: editing tools open on their change, not on their input JSON', () => {
  it('replaces the input JSON of an Edit row with the diff', async () => {
    const user = userEvent.setup()
    render(
      <ToolRow
        toolUse={makeToolUse({
          id: 't1',
          toolName: 'Edit',
          toolInput: { file_path: '/a.ts', old_string: 'before\n', new_string: 'after\n' },
        })}
        toolResult={makeToolResult({ id: 'r1', toolUseId: 't1', text: 'ok' })}
      />
    )
    await user.click(screen.getByRole('button', { name: /Edit: \/a\.ts/ }))

    expect(screen.queryByText(/"old_string"/)).not.toBeInTheDocument()
    expect(screen.getByText('before')).toBeInTheDocument()
    expect(screen.getByText('after')).toBeInTheDocument()
  })

  it('keeps the input JSON for every other tool', async () => {
    const user = userEvent.setup()
    render(
      <ToolRow
        toolUse={makeToolUse({ id: 't1', toolName: 'Grep', toolInput: { pattern: 'x' } })}
        toolResult={makeToolResult({ id: 'r1', toolUseId: 't1', text: 'ok' })}
      />
    )
    await user.click(screen.getByRole('button', { name: /Grep/ }))
    expect(screen.getByText(/"pattern"/)).toBeInTheDocument()
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
          toolName: 'Read',
          toolInput: { file_path: '/a/b/store.ts', offset: 12 },
        })}
      />
    )

    await user.click(screen.getByRole('button', { name: /Read: \/a\/b\/store\.ts/ }))

    // One in the collapsed label, one inside the pretty-printed INPUT.
    expect(container.querySelectorAll('[data-path-button]')).toHaveLength(2)
    // Everything else in the JSON stays text.
    expect(screen.getByText(/"offset"/)).toBeInTheDocument()

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

// ---------------------------------------------------------------------------
// `OPEN →` (spec 2026-09-22-subagent-transcript-panel-design.md § 5,
// canvas 11a — task 9)
// ---------------------------------------------------------------------------

import type { Subagent } from '../lib/types'

function makeSubagentFixture(overrides: Partial<Subagent> & { id: string }): Subagent {
  return { name: 'sub', state: 'working', startedAt: 0, ...overrides }
}

describe('ToolRow: OPEN → subagent control', () => {
  it('renders OPEN → for an Agent row joined to a live subagent by toolUseId, and clicking it opens that subagent', async () => {
    const user = userEvent.setup()
    const onOpenSubagent = vi.fn()
    const subagent = makeSubagentFixture({ id: 'agent-1', toolUseId: 'tool-1', name: 'run tests' })
    render(
      <ToolRow
        toolUse={makeToolUse({ id: 'tool-1', toolName: 'Agent', toolInput: { description: 'run tests' } })}
        subagents={[subagent]}
        onOpenSubagent={onOpenSubagent}
      />
    )

    const open = screen.getByRole('button', { name: /Open subagent transcript: run tests/ })
    await user.click(open)
    expect(onOpenSubagent).toHaveBeenCalledTimes(1)
    expect(onOpenSubagent).toHaveBeenCalledWith(subagent)
  })

  it('a Task-named row (an older CLI transcript) gets the same control', () => {
    const subagent = makeSubagentFixture({ id: 'agent-1', toolUseId: 'tool-1' })
    render(
      <ToolRow
        toolUse={makeToolUse({ id: 'tool-1', toolName: 'Task', toolInput: { description: 'run tests' } })}
        subagents={[subagent]}
        onOpenSubagent={vi.fn()}
      />
    )
    expect(screen.getByText('OPEN →')).toBeInTheDocument()
  })

  /**
   * A finished agent's moon leaves the map (subagent list spec § 5), so this
   * row is one of the two ways left into its transcript: "unlike the moon
   * this is part of the record forever" (subagent panel spec § 5).
   */
  it('still renders OPEN → for an ENDED agent — the moon leaves the map, not the record', async () => {
    const user = userEvent.setup()
    const onOpenSubagent = vi.fn()
    const ended = makeSubagentFixture({
      id: 'agent-1',
      toolUseId: 'tool-1',
      name: 'run tests',
      state: 'ended',
      status: 'completed',
      endedAt: 5000,
    })
    render(
      <ToolRow
        toolUse={makeToolUse({ id: 'tool-1', toolName: 'Agent', toolInput: { description: 'run tests' } })}
        subagents={[ended]}
        onOpenSubagent={onOpenSubagent}
      />
    )

    await user.click(screen.getByRole('button', { name: /Open subagent transcript: run tests/ }))
    expect(onOpenSubagent).toHaveBeenCalledWith(ended)
  })

  it('renders no control when no live agent matches the row\'s toolUseId — a depth-2 call, or a server that has forgotten the agent', () => {
    render(
      <ToolRow
        toolUse={makeToolUse({ id: 'tool-1', toolName: 'Agent', toolInput: { description: 'run tests' } })}
        subagents={[makeSubagentFixture({ id: 'agent-1', toolUseId: 'some-other-tool-use' })]}
        onOpenSubagent={vi.fn()}
      />
    )
    expect(screen.queryByText('OPEN →')).not.toBeInTheDocument()
  })

  it('renders no control when `subagents` is never passed — the subagent panel\'s own transcript, depth-2 calls', () => {
    render(
      <ToolRow toolUse={makeToolUse({ id: 'tool-1', toolName: 'Agent', toolInput: { description: 'run tests' } })} />
    )
    expect(screen.queryByText('OPEN →')).not.toBeInTheDocument()
  })

  it('renders no control for a non-Agent/Task tool even if its toolUseId happens to match a subagent', () => {
    render(
      <ToolRow
        toolUse={makeToolUse({ id: 'tool-1', toolName: 'Bash', toolInput: { command: 'echo hi' } })}
        subagents={[makeSubagentFixture({ id: 'agent-1', toolUseId: 'tool-1' })]}
        onOpenSubagent={vi.fn()}
      />
    )
    expect(screen.queryByText('OPEN →')).not.toBeInTheDocument()
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

  it('turns a code span that is exactly a path into a path button inside the chip', () => {
    const { container } = render(
      <MessageView message={makeMessage({ id: '1', text: 'spec: `docs/specs/x.md:12`' })} />
    )

    const button = container.querySelector('code [data-path-button]')!
    expect(button).toHaveTextContent('docs/specs/x.md:12')

    fireEvent.click(button)
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: 'docs/specs/x.md', line: 12 })
  })

  it('never touches a path inside a longer code span or a fenced block', () => {
    const text = 'run `cat web/src/App.tsx` and\n\n```\ndocs/readme.md\n```'
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

const thinking = (id: string, model?: string, timestamp?: string): ChatMessage => ({
  id, role: 'thinking', text: `t-${id}`, model, timestamp,
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

  // A notice is the CLI answering for itself. It carries no model precisely
  // so that it cannot break a model run in two — a `/context` between two
  // turns of the same model must not produce a divider on either side of it.
  it('is not interrupted by a notice between two turns of the same model', () => {
    const groups = insertModelDividers(
      groupsOf([
        assistant('a1', 'claude-opus-5'),
        { id: 'n1', role: 'notice', text: '## Context Usage', notice: { level: 'notice', command: '/context' } },
        assistant('a2', 'claude-opus-5'),
      ]),
    )
    expect(groups.some((g) => g.kind === 'model-divider')).toBe(false)
    expect(groups.map((g) => g.kind)).toEqual(['message', 'message', 'message'])
  })

  // A turn that opens with reasoning carries the new model on its `thinking`
  // row, one row before the prose that used to be the earliest place the
  // switch could be seen — the divider has to land there too, or the new
  // model's own reasoning renders above a divider that hasn't announced it
  // yet (fix a-thinking-block-opens-a-turn-above-its-own-model-divider).
  it('marks a change that a turn opening with thinking carries on its thinking row', () => {
    const groups = insertModelDividers(
      groupsOf([
        assistant('a1', 'claude-sonnet-5'),
        thinking('t1', 'claude-opus-5', '2026-09-16T14:02:00Z'),
        assistant('a2', 'claude-opus-5'),
      ]),
    )
    expect(groups.map((g) => g.kind)).toEqual(['message', 'model-divider', 'message', 'message'])
    const divider = groups.find((g) => g.kind === 'model-divider')
    expect(divider).toMatchObject({ from: 'claude-sonnet-5', to: 'claude-opus-5' })
  })
})

describe('pairMessages: notices', () => {
  it('keeps a notice as a row of its own rather than folding it into a tool run', () => {
    const items = pairMessages([
      { id: '1', role: 'tool_use', toolName: 'Bash', toolUseId: 'tu1' },
      { id: '2', role: 'tool_result', toolUseId: 'tu1', text: 'ok' },
      { id: '3', role: 'notice', text: '/status isn\'t available', notice: { level: 'notice' } },
      { id: '4', role: 'tool_use', toolName: 'Read', toolUseId: 'tu2' },
    ])
    expect(items.map((i) => i.kind)).toEqual(['tool', 'message', 'tool'])
    const groups = groupToolRuns(items)
    // The notice breaks the run, so the two calls never fold together behind
    // a header that would hide it.
    expect(groups.map((g) => g.kind)).toEqual(['tools', 'message', 'tools'])
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

  // Infinite scroll (ADR transcript-pages-older-history-on-scroll). The
  // observer is faked: `reachTop` is the reader's scroll bringing the
  // sentinel into view, reported to whichever observer is currently live.
  function fakeScroll() {
    let live: IntersectionObserverCallback | null = null
    const observerFactory = (callback: IntersectionObserverCallback) => {
      const self = {
        observe: () => {
          live = callback
        },
        disconnect: () => {
          if (live === callback) live = null
        },
      }
      return self
    }
    const reachTop = async () => {
      await act(async () => {
        live?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
      })
    }
    return { observerFactory, reachTop, observing: () => live !== null }
  }

  it('asks the store for the page before the oldest message when the reader reaches the top', async () => {
    const loadOlderSpy = vi.fn().mockResolvedValue([])
    resetStore({ transcripts: { s1: [{ id: '5', role: 'user', text: 'hello' }] } })
    useOrbital.setState({ loadOlder: loadOlderSpy })
    const scroll = fakeScroll()

    render(<Transcript sessionId="s1" observerFactory={scroll.observerFactory} />)
    await scroll.reachTop()

    expect(loadOlderSpy).toHaveBeenCalledWith('s1')
    expect(screen.queryByRole('button', { name: /load older/i })).not.toBeInTheDocument()
  })

  it('prepends older messages returned by loadOlder while keeping existing ones in place', async () => {
    resetStore({ transcripts: { s1: [{ id: '5', role: 'user', text: 'newer message' }] } })
    const loadOlderSpy = vi.fn().mockImplementation(async (id: string) => {
      const older: ChatMessage = { id: '1', role: 'user', text: 'older message' }
      useOrbital.setState((state) => ({
        transcripts: { ...state.transcripts, [id]: [older, ...state.transcripts[id]] },
      }))
      return [older]
    })
    useOrbital.setState({ loadOlder: loadOlderSpy })
    const scroll = fakeScroll()

    render(<Transcript sessionId="s1" observerFactory={scroll.observerFactory} />)
    await scroll.reachTop()

    expect(await screen.findByText('older message')).toBeInTheDocument()
    expect(screen.getByText('newer message')).toBeInTheDocument()
  })

  it('grows the visible window so newly loaded older messages actually appear (regression: window used to stay pinned to the last 200 raw messages, hiding anything loadOlder prepended)', async () => {
    // The realistic steady state: exactly the window size already stored
    // and visible, so nothing is hidden yet when the reader reaches the top.
    const initial: ChatMessage[] = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      role: 'user',
      text: `message ${i}`,
    }))
    resetStore({ transcripts: { s1: initial } })
    const older: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      id: `older${i}`,
      role: 'user',
      text: `older message ${i}`,
    }))
    useOrbital.setState({
      loadOlder: vi.fn().mockImplementation(async (id: string) => {
        useOrbital.setState((state) => ({
          transcripts: { ...state.transcripts, [id]: [...older, ...state.transcripts[id]] },
        }))
        return older
      }),
    })
    const scroll = fakeScroll()

    render(<Transcript sessionId="s1" observerFactory={scroll.observerFactory} />)
    expect(screen.getByText('message 0')).toBeInTheDocument()
    await scroll.reachTop()

    // The newly prepended page must actually render, not just sit in the
    // store while the window stays pinned to its old size.
    expect(await screen.findByText('older message 0')).toBeInTheDocument()
    expect(screen.getByText('older message 49')).toBeInTheDocument()
  })

  // A launched session's oldest held message is its optimistic first prompt;
  // at the window's cap it is cut off, and the server — cursored on it — has
  // nothing older to give. Only the window growing can bring it back.
  it('reveals rows the window cut off before fetching anything, one step per scroll to the top', async () => {
    const initial: ChatMessage[] = Array.from({ length: 360 }, (_, i) => ({
      id: `m${i}`,
      role: 'user',
      text: `message ${i}`,
    }))
    resetStore({ transcripts: { s1: initial } })
    const loadOlderSpy = vi.fn().mockResolvedValue([])
    useOrbital.setState({ loadOlder: loadOlderSpy })
    const scroll = fakeScroll()

    render(<Transcript sessionId="s1" observerFactory={scroll.observerFactory} />)
    expect(screen.queryByText('message 159')).not.toBeInTheDocument()

    await scroll.reachTop()
    // One step, not the whole backlog: 160 were cut off.
    expect(screen.getByText('message 60')).toBeInTheDocument()
    expect(screen.queryByText('message 59')).not.toBeInTheDocument()
    expect(loadOlderSpy).not.toHaveBeenCalled()

    await scroll.reachTop()
    expect(screen.getByText('message 0')).toBeInTheDocument()
    expect(loadOlderSpy).not.toHaveBeenCalled()

    // Everything held is on screen; only now is the server asked.
    await scroll.reachTop()
    expect(loadOlderSpy).toHaveBeenCalledTimes(1)
  })

  it('stops paging once loadOlder reports an empty page', async () => {
    resetStore({ transcripts: { s1: [{ id: '1', role: 'user', text: 'only message' }] } })
    const loadOlderSpy = vi.fn().mockResolvedValue([])
    useOrbital.setState({ loadOlder: loadOlderSpy })
    const scroll = fakeScroll()

    render(<Transcript sessionId="s1" observerFactory={scroll.observerFactory} />)
    await scroll.reachTop()

    expect(await screen.findByText('only message')).toBeInTheDocument()
    expect(scroll.observing()).toBe(false)
    await scroll.reachTop()
    expect(loadOlderSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps paging after a failed fetch, so the next scroll to the top tries again', async () => {
    resetStore({ transcripts: { s1: [{ id: '1', role: 'user', text: 'only message' }] } })
    const loadOlderSpy = vi.fn().mockResolvedValue(null)
    useOrbital.setState({ loadOlder: loadOlderSpy })
    const scroll = fakeScroll()

    render(<Transcript sessionId="s1" observerFactory={scroll.observerFactory} />)
    await scroll.reachTop()
    await scroll.reachTop()

    expect(scroll.observing()).toBe(true)
    expect(loadOlderSpy).toHaveBeenCalledTimes(2)
  })

  it('does not ask again while a page is still in flight', async () => {
    resetStore({ transcripts: { s1: [{ id: '1', role: 'user', text: 'only message' }] } })
    let resolve: (v: ChatMessage[]) => void = () => {}
    const loadOlderSpy = vi.fn().mockImplementation(() => new Promise<ChatMessage[]>((r) => (resolve = r)))
    useOrbital.setState({ loadOlder: loadOlderSpy })
    const scroll = fakeScroll()

    render(<Transcript sessionId="s1" observerFactory={scroll.observerFactory} />)
    await scroll.reachTop()
    await scroll.reachTop()
    expect(loadOlderSpy).toHaveBeenCalledTimes(1)

    await act(async () => resolve([]))
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
    // Folded by default: no openable ToolRows, one header, and — because a
    // message follows the run, so it is not the leading edge — no live
    // trace beneath it, even though tu2 has no result.
    expect(runs[0].querySelectorAll('[data-role="tool"]')).toHaveLength(0)
    expect(screen.getByRole('button', { name: /2 tool calls/ })).toBeInTheDocument()
    expect(runs[0].querySelector('[data-live-tool]')).not.toBeInTheDocument()
  })

  it('renders a `thinking` message through the thinking path, never as an assistant bubble (the live defect § 7 closes)', () => {
    resetStore({
      transcripts: {
        s1: [
          { id: '1', role: 'user', text: 'go' },
          { id: '2', role: 'thinking', text: 'weighing the two approaches' },
          { id: '3', role: 'assistant', text: 'done' },
        ],
      },
    })

    const { container } = render(<Transcript sessionId="s1" />)

    // The text is present either way — that is exactly why the bug was
    // invisible — so the assertion can't just be "a data-role=\"thinking\"
    // element exists": `MessageView` sets `data-role={message.role}`
    // UNCONDITIONALLY (line ~213), so under the OLD bug a thinking message
    // routed through `MessageView` would still have carried
    // `data-role="thinking"` on its wrapper — the bug was in the STYLING
    // (an assistant markdown bubble), not that attribute. The genuine
    // difference is what `MessageView` alone would have produced: a
    // `.message-markdown` bubble (its markdown-rendering path) containing
    // this text. `ThinkingBlock` never uses that class, and it alone
    // renders the THINKING label and the boxed/hairline container.
    const markdownBubbles = Array.from(container.querySelectorAll('.message-markdown'))
    expect(markdownBubbles.some((el) => el.textContent?.includes('weighing the two approaches'))).toBe(false)
    expect(container.querySelector('[data-thinking-variant="boxed"]')).toBeInTheDocument()
    expect(screen.getByText('THINKING')).toBeInTheDocument()
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

  // `use()` above builds items with no timestamp at all, so `durationMs` is
  // `undefined` for every case already covered — this section is the
  // duration-specific behaviour, built on its own timestamped items.
  const timed = (id: string, name: string, startMs: number, endMs?: number) => ({
    kind: 'tool' as const,
    key: id,
    toolUse: makeToolUse({ id, toolName: name, timestamp: new Date(startMs).toISOString() }),
    toolResult: endMs === undefined
      ? undefined
      : makeToolResult({ id: `${id}r`, toolUseId: id, timestamp: new Date(endMs).toISOString() }),
  })

  it("sums every item's duration into the run total (canvas 11b: appended as \"· 6.2s\")", () => {
    const s = summarizeToolRun([
      timed('1', 'Read', 0, 300),
      timed('2', 'Bash', 300, 6_200),
    ])
    expect(s.durationMs).toBe(6_200)
  })

  it('reports no run duration when any one item is missing a timestamp — a partial sum would understate an unknown total', () => {
    const s = summarizeToolRun([
      timed('1', 'Read', 0, 300),
      use('2', 'Bash'), // no timestamps at all
    ])
    expect(s.durationMs).toBeUndefined()
  })

  it('reports no run duration while one item is still running', () => {
    const s = summarizeToolRun([
      timed('1', 'Read', 0, 300),
      timed('2', 'Bash', 300), // no end timestamp — still running
    ])
    expect(s.durationMs).toBeUndefined()
  })
})

import { leadingEdgeItem } from '../panels/TranscriptView'

describe('leadingEdgeItem', () => {
  const finished = { id: 'a', done: true }
  const unfinished = { id: 'b', done: false }

  it('a live last run holds its unfinished last call', () => {
    expect(leadingEdgeItem([finished, unfinished], true, true)).toBe(unfinished)
  })

  it('a live last run holds its last call after it finishes', () => {
    expect(leadingEdgeItem([unfinished, finished], true, true)).toBe(finished)
  })

  it('a run that is not the last group holds nothing', () => {
    expect(leadingEdgeItem([finished, unfinished], false, true)).toBeUndefined()
  })

  it('a run in a turn that is not live holds nothing', () => {
    expect(leadingEdgeItem([finished, unfinished], true, false)).toBeUndefined()
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

  // The same transcript, in a session that is still running its turn.
  const renderLive = (messages: ChatMessage[]) => {
    resetStore({
      transcripts: { s1: messages },
      sessions: {
        s1: {
          id: 's1',
          cwd: '/tmp',
          title: 's1',
          firstAt: 1,
          lastAt: 2,
          messageCount: messages.length,
          source: 'web',
          permissionMode: null,
          model: null,
          resolvedModel: null,
          tagIds: [],
          status: 'working',
          subagents: [],
        },
      },
    })
    return render(<Transcript sessionId="s1" />)
  }
  const append = (...extra: ChatMessage[]) =>
    act(() => {
      useOrbital.setState((s) => ({ transcripts: { ...s.transcripts, s1: [...s.transcripts.s1, ...extra] } }))
    })
  const setStatus = (status: 'working' | 'idle') =>
    act(() => {
      useOrbital.setState((s) => ({ sessions: { s1: { ...s.sessions.s1, status } } }))
    })

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

  it('a live run stays folded with the unfinished call visible beneath the header', () => {
    renderLive(run(3, { unfinishedLast: true }))
    const header = screen.getByRole('button', { name: /3 tool calls/ })
    expect(header).toHaveTextContent('running')
    // The unfinished row is a plain trace, not an openable ToolRow. (The
    // salient path sits in its own span, so it's the single-node target.)
    expect(screen.getByText('f3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Read: f3/ })).not.toBeInTheDocument()
    // The finished calls stay folded into the count.
    expect(screen.queryByText('f1')).not.toBeInTheDocument()
  })

  it('the leading-edge row holds its place when its call finishes, until something follows the run', () => {
    const { container, rerender } = renderLive(run(2, { unfinishedLast: true }))
    expect(container.querySelector('[data-live-tool]')).toHaveTextContent('f2')

    // The call finishes, the next has not arrived: the row stays, showing
    // the finished call, and the header stops saying `running`.
    append({ id: 'r2', role: 'tool_result', toolUseId: 'tu2', text: 'ok' })
    rerender(<Transcript sessionId="s1" />)
    expect(container.querySelector('[data-live-tool]')).toHaveTextContent('f2')
    expect(screen.getByRole('button', { name: /2 tool calls/ })).not.toHaveTextContent('running')

    // The next call arrives: the same row now shows it.
    append({ id: 't3', role: 'tool_use', toolName: 'Grep', toolInput: { pattern: 'needle' }, toolUseId: 'tu3' })
    rerender(<Transcript sessionId="s1" />)
    expect(container.querySelectorAll('[data-live-tool]')).toHaveLength(1)
    expect(container.querySelector('[data-live-tool]')).toHaveTextContent('Grep')

    // A message follows the run: it is no longer the leading edge.
    append({ id: 'r3', role: 'tool_result', toolUseId: 'tu3', text: 'ok' }, { id: 'a', role: 'assistant', text: 'done' })
    rerender(<Transcript sessionId="s1" />)
    expect(container.querySelector('[data-live-tool]')).not.toBeInTheDocument()
  })

  it('the leading-edge row leaves when the turn ends', () => {
    const { container, rerender } = renderLive(run(2))
    expect(container.querySelector('[data-live-tool]')).toHaveTextContent('f2')
    setStatus('idle')
    rerender(<Transcript sessionId="s1" />)
    expect(container.querySelector('[data-live-tool]')).not.toBeInTheDocument()
  })

  it('a run in a session that is not working has no live row, even with an unfinished call', () => {
    const { container } = renderTranscript(run(2, { unfinishedLast: true }))
    expect(container.querySelector('[data-live-tool]')).not.toBeInTheDocument()
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
