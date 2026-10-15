import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRef, useState } from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { Composer, type ComposerControl, type ComposerProps } from '../panels/Composer'
import { backspace, clickAndType, editorOf, fieldValue, replaceField, typeInto } from './composerField'
import { escapeLayerDepth } from '../ui/escapeLayer'
import type { SlashCommand, FileCompletionEntry } from '../lib/types'

// ---------------------------------------------------------------------------
// Fixtures + harness
// ---------------------------------------------------------------------------

const COMMANDS: SlashCommand[] = [
  { name: '/code-review', description: 'Review the staged diff', source: 'project' },
  { name: '/commit', description: 'Stage, write a message, commit', source: 'project' },
  { name: '/compact', description: 'Summarise the run', source: 'built-in' },
  { name: '/coverage', description: 'Run the suite with coverage', source: 'user' },
  { name: '/container-logs', description: "Tail the dev container's logs", source: 'plugin' },
  { name: '/cost', description: 'Token spend for this session', source: 'built-in' },
  { name: '/doctor', description: 'Check the install', source: 'built-in' },
]

const ENTRIES: FileCompletionEntry[] = [
  { name: 'compare-runs.ts', dir: false, size: 4100 },
  { name: 'components', dir: true },
  { name: 'composer.tsx', dir: false, size: 12800 },
]

/** Controlled wrapper — both real mounts own the draft, so the harness does too. */
function Harness({
  initial = '',
  onSend,
  ...props
}: Partial<ComposerProps> & { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <Composer
      sessionKey={{ session: 's1' }}
      value={value}
      onChange={setValue}
      enter="send"
      onSend={onSend}
      placement="above"
      variant="panel"
      hint="⏎ send · ⇧⏎ newline · ⌘V paste image"
      aria-label="Prompt"
      {...props}
    />
  )
}

const field = () => screen.getByRole('textbox', { name: 'Prompt' })
const popup = () => screen.queryByRole('listbox', { name: /completions/i })
const rows = () => screen.queryAllByRole('option')
const selectedRow = () => rows().find((r) => r.dataset.selected === 'true')

beforeEach(() => {
  vi.mocked(api.commands).mockResolvedValue(COMMANDS)
  vi.mocked(api.filesComplete).mockResolvedValue(ENTRIES)
})

// ---------------------------------------------------------------------------
// The field + the token paint (canvas 9a)
// ---------------------------------------------------------------------------

/** A mention with a `:line` is painted as two spans; this is the whole of it. */
const mentionText = () =>
  [...field().querySelectorAll('[data-token="mention"]')].map((n) => n.textContent).join('')

describe('Composer — the token paint', () => {
  it('shows the markdown it was given, and hands the same markdown back', () => {
    render(<Harness initial="plain prose" />)
    expect(fieldValue(field())).toBe('plain prose')
    expect(field().textContent).toBe('plain prose')
  })

  it('leaves the text untouched while marking a known command token', async () => {
    render(<Harness initial="/code-review the staged diff" />)
    await waitFor(() => expect(field().querySelector('[data-token="command"]')).not.toBeNull())
    expect(field().textContent).toBe('/code-review the staged diff')
    expect(field().querySelector('[data-token="command"]')).toHaveTextContent('/code-review')
  })

  it('marks a command wherever it starts a word, and leaves an unknown slug plain', async () => {
    render(<Harness initial="/commit then run /code-review and /comand" />)
    await waitFor(() =>
      expect(field().querySelectorAll('[data-token="command"]')).toHaveLength(2)
    )
    const marked = [...field().querySelectorAll('[data-token="command"]')].map((n) => n.textContent)
    expect(marked).toEqual(['/commit', '/code-review'])
    expect(field().textContent).toBe('/commit then run /code-review and /comand')
  })

  it('does not mark a command inside inline code', async () => {
    render(<Harness initial="run `/commit` then /commit" />)
    await waitFor(() => expect(api.commands).toHaveBeenCalled())
    await waitFor(() =>
      expect(field().querySelectorAll('[data-token="command"]')).toHaveLength(1)
    )
    expect(field().querySelector('code [data-token], [data-token] code')).toBeNull()
  })

  it('tints a hand-typed mention once the debounced probe confirms the path', async () => {
    vi.mocked(api.filesComplete).mockResolvedValue([{ name: 'App.tsx', dir: false, size: 10 }])
    render(<Harness />)
    clickAndType(field(), 'from @web/src/App.tsx:42 ')

    await waitFor(() => expect(field().querySelector('[data-token="mention"]')).not.toBeNull())
    expect(mentionText()).toBe('@web/src/App.tsx:42')
    expect(field().querySelector('[data-token-suffix]')).toHaveTextContent(':42')
    expect(field().textContent).toBe('from @web/src/App.tsx:42 ')
  })

  it('leaves a mention the server does not know plain — the tint is a receipt', async () => {
    vi.mocked(api.filesComplete).mockResolvedValue([])
    render(<Harness />)
    clickAndType(field(), 'from @web/src/Nope.tsx ')

    await waitFor(() =>
      expect(api.filesComplete).toHaveBeenCalledWith({ session: 's1' }, 'web/src/Nope.tsx')
    )
    expect(field().querySelector('[data-token="mention"]')).toBeNull()
    expect(field().textContent).toBe('from @web/src/Nope.tsx ')
  })
})

// ---------------------------------------------------------------------------
// The argument hint (spec 2026-09-29-composer-rich-editor-design § 3)
// ---------------------------------------------------------------------------

describe('Composer — the argument hint', () => {
  const ghost = () => field().querySelector('[data-argument-hint]')

  beforeEach(() => {
    vi.mocked(api.commands).mockResolvedValue([
      ...COMMANDS,
      { name: '/fix-issue', description: 'Fix one', source: 'project', argumentHint: '[issue-number]' },
    ])
  })

  it('ghosts the hint after an accepted command, and drops it on the first character', async () => {
    render(<Harness />)
    clickAndType(field(), '/fix-i')
    await waitFor(() => expect(rows()).toHaveLength(1))
    fireEvent.keyDown(field(), { key: 'Enter' })

    await waitFor(() => expect(ghost()).toHaveTextContent('[issue-number]'))
    // Drawn, never text: the field still hands out only what was typed.
    expect(fieldValue(field())).toBe('/fix-issue ')

    typeInto(field(), '4')
    expect(ghost()).toBeNull()
    expect(fieldValue(field())).toBe('/fix-issue 4')
  })

  it('draws nothing for a command without a hint', async () => {
    render(<Harness />)
    clickAndType(field(), '/commit ')
    await waitFor(() => expect(api.commands).toHaveBeenCalled())
    await waitFor(() => expect(field().querySelector('[data-token="command"]')).not.toBeNull())
    expect(ghost()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The hint line (canvas 9a/9d/9e)
// ---------------------------------------------------------------------------

describe('Composer — the hint line', () => {
  it('swaps in a NOT-IN-CACHE note for a command that does not exist', async () => {
    render(<Harness initial="/comand the diff" />)
    expect(await screen.findByText('no command /comand — sends as typed')).toBeInTheDocument()
    expect(screen.queryByText('⏎ send · ⇧⏎ newline · ⌘V paste image')).not.toBeInTheDocument()
  })

  it('keeps quiet while the slug is still a live prefix', async () => {
    render(<Harness initial="/co" />)
    await waitFor(() => expect(api.commands).toHaveBeenCalled())
    expect(screen.queryByText(/no command/)).not.toBeInTheDocument()
  })

  it('hands the line to the open list, then takes it back (canvas 9b)', async () => {
    render(<Harness />)
    clickAndType(field(), '/co')
    await screen.findByRole('option', { name: /code-review/ })

    expect(screen.getByText('⏎ accept · esc closes the list · ⌘V paste image')).toBeInTheDocument()
    expect(screen.queryByText('⏎ send · ⇧⏎ newline · ⌘V paste image')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.getByText('⏎ send · ⇧⏎ newline · ⌘V paste image')).toBeInTheDocument()
    )
  })
})

// ---------------------------------------------------------------------------
// Enter behaviour, per mount (canvas 9d)
// ---------------------------------------------------------------------------

describe('Composer — enter behaviour', () => {
  /** The document's top-level blocks, by type. */
  const blocks = () => {
    const names: string[] = []
    editorOf(field()).state.doc.forEach((node) => names.push(node.type.name))
    return names
  }

  it('sends on ⏎ and newlines on ⇧⏎ in the panel mount', async () => {
    const onSend = vi.fn()
    render(<Harness initial="line one" onSend={onSend} />)

    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    expect(blocks()).toEqual(['paragraph', 'paragraph'])

    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('line one')
  })

  it('newlines on ⏎ in the dialog mount and never sends', () => {
    const onSend = vi.fn()
    render(<Harness initial="line one" enter="newline" onSend={onSend} />)

    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    // The editor's own newline happened: a new paragraph under the first.
    expect(blocks()).toEqual(['paragraph', 'paragraph'])
  })

  it('breaks the line on ⇧⏎ in the dialog mount, inside the same paragraph', () => {
    render(<Harness initial="line one" enter="newline" />)
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true })
    typeInto(field(), 'line two')
    expect(blocks()).toEqual(['paragraph'])
    expect(fieldValue(field())).toBe('line one  \nline two')
  })

  it('turns `- ` into a list, and ⏎ into its next item in the dialog mount', () => {
    render(<Harness enter="newline" />)
    clickAndType(field(), '- one')
    expect(blocks()[0]).toBe('bulletList')

    fireEvent.keyDown(field(), { key: 'Enter' })
    typeInto(field(), 'two')
    expect(fieldValue(field())).toBe('- one\n- two')

    // ⏎ on an empty item leaves the list.
    fireEvent.keyDown(field(), { key: 'Enter' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    typeInto(field(), 'after')
    expect(fieldValue(field())).toBe('- one\n- two\n\nafter')
  })

  it('formats emphasis as it is typed, and leaves stars around spaces as typed', () => {
    render(<Harness enter="newline" />)
    clickAndType(field(), 'a **bold** and _it_ word, 2 * 3 * 4')
    expect(field().querySelector('strong')).toHaveTextContent('bold')
    expect(field().querySelector('em')).toHaveTextContent('it')
    expect(fieldValue(field())).toBe('a **bold** and *it* word, 2 * 3 * 4')
  })

  it('breaks the line inside a list item on ⇧⏎ in the dialog mount', () => {
    render(<Harness enter="newline" />)
    clickAndType(field(), '1. one')
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true })
    typeInto(field(), 'still one')
    expect(blocks()[0]).toBe('orderedList')
    expect(editorOf(field()).state.doc.firstChild!.childCount).toBe(1)
  })

  it('makes ⇧⏎ the next item in the panel mount, and ⏎ sends the whole list', () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    clickAndType(field(), '- one')
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true })
    typeInto(field(), 'two')
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('- one\n- two')
  })

  it('nests a list item on Tab and lifts it back on ⇧Tab', () => {
    render(<Harness enter="newline" />)
    clickAndType(field(), '- one')
    fireEvent.keyDown(field(), { key: 'Enter' })
    typeInto(field(), 'two')

    fireEvent.keyDown(field(), { key: 'Tab' })
    expect(fieldValue(field())).toBe('- one\n  - two')
    fireEvent.keyDown(field(), { key: 'Tab', shiftKey: true })
    expect(fieldValue(field())).toBe('- one\n- two')
  })

  it('lets ⌘⏎ through untouched, whatever the mount', () => {
    const onSend = vi.fn()
    render(<Harness initial="x" enter="newline" onSend={onSend} />)
    const e = fireEvent.keyDown(field(), { key: 'Enter', metaKey: true })
    expect(onSend).not.toHaveBeenCalled()
    expect(e).toBe(true)
  })

  it('does not send an empty or whitespace-only field', () => {
    const onSend = vi.fn()
    render(<Harness initial="   " onSend={onSend} />)
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The completion popup (canvas 9b)
// ---------------------------------------------------------------------------

describe('CompletionPopup — commands', () => {
  it('opens on a / at position 0 and lists the catalog', async () => {
    render(<Harness />)
    clickAndType(field(), '/')

    expect(await screen.findByRole('option', { name: /code-review/ })).toBeInTheDocument()
    expect(api.commands).toHaveBeenCalledWith({ session: 's1' })
    expect(popup()).toBeInTheDocument()
  })

  it('opens on a / that starts a word later in the prompt', async () => {
    render(<Harness />)
    clickAndType(field(), 'then run /co')
    await screen.findByRole('option', { name: /code-review/ })
  })

  it("opens from the mount's / control, as a word of its own after text", async () => {
    const control = createRef<ComposerControl>()
    render(<Harness initial="then run" control={control} />)
    act(() => control.current?.startCommand())

    await screen.findByRole('option', { name: /code-review/ })
    expect(fieldValue(field())).toBe('then run /')
  })

  it('inserts a command accepted mid-prompt in place, leaving the prose alone', async () => {
    render(<Harness />)
    clickAndType(field(), 'then run /code-r')
    await screen.findByRole('option', { name: /code-review/ })
    fireEvent.keyDown(field(), { key: 'Enter' })
    await waitFor(() => expect(fieldValue(field())).toBe('then run /code-review '))
  })

  it('prefix-filters as you type, resetting the selection to the first row', async () => {
    render(<Harness />)
    clickAndType(field(), '/co')
    await screen.findByRole('option', { name: /code-review/ })
    expect(rows()).toHaveLength(6)

    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(selectedRow()).toHaveAccessibleName(/\/commit/)

    // `/com` narrows to commit + compact, and the selection goes back to row 0.
    typeInto(field(), 'm')
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(selectedRow()).toHaveAccessibleName(/\/commit/)
  })

  it('wraps the selection at both ends', async () => {
    render(<Harness />)
    clickAndType(field(), '/cost')
    await waitFor(() => expect(rows()).toHaveLength(1))

    // A single row wraps onto itself in both directions.
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(selectedRow()).toHaveAccessibleName(/\/cost/)
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(selectedRow()).toHaveAccessibleName(/\/cost/)

    replaceField(field(), '/com')
    await waitFor(() => expect(rows()).toHaveLength(2))
    // Up from the top lands on the last row, down from there wraps home.
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(selectedRow()).toHaveAccessibleName(/\/compact/)
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(selectedRow()).toHaveAccessibleName(/\/commit/)
  })

  it('accepts on ⏎, replacing the fragment and adding one trailing space', async () => {
    render(<Harness />)
    clickAndType(field(), '/comm')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(fieldValue(field())).toBe('/commit ')
    await waitFor(() => expect(popup()).toBeNull())
  })

  it('accepts on Tab too, and Tab does not move focus out of the field', async () => {
    render(<Harness />)
    clickAndType(field(), '/comm')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.keyDown(field(), { key: 'Tab' })
    expect(fieldValue(field())).toBe('/commit ')
    expect(document.activeElement).toBe(field())
  })

  it('does not send when ⏎ is the popup`s — the accept is not a turn', async () => {
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    clickAndType(field(), '/comm')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('closes on Escape, one layer only, leaving the text and the focus alone', async () => {
    render(<Harness />)
    const before = escapeLayerDepth()
    clickAndType(field(), '/co')
    await waitFor(() => expect(escapeLayerDepth()).toBe(before + 1))

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(popup()).toBeNull())
    expect(escapeLayerDepth()).toBe(before)
    expect(fieldValue(field())).toBe('/co')
    expect(document.activeElement).toBe(field())
  })

  it('stays closed after Escape until the trigger is typed again', async () => {
    render(<Harness />)
    clickAndType(field(), '/co')
    await screen.findByRole('option', { name: /code-review/ })
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(popup()).toBeNull())

    typeInto(field(), 'm')
    await waitFor(() => expect(popup()).toBeNull())
  })

  it('closes when ⌫ takes the caret back past the trigger', async () => {
    render(<Harness />)
    clickAndType(field(), '/c')
    await screen.findByRole('option', { name: /code-review/ })

    backspace(field(), 2)
    await waitFor(() => expect(popup()).toBeNull())
    expect(fieldValue(field())).toBe('')
  })

  it('closes on no match rather than showing an empty shell', async () => {
    render(<Harness />)
    clickAndType(field(), '/co')
    await screen.findByRole('option', { name: /code-review/ })

    typeInto(field(), 'mand')
    await waitFor(() => expect(popup()).toBeNull())
    expect(rows()).toHaveLength(0)
  })

  it('carries a name, a description and a source badge per row (canvas 9b)', async () => {
    render(<Harness />)
    clickAndType(field(), '/co')
    const row = await screen.findByRole('option', { name: /code-review/ })

    expect(row).toHaveTextContent('/code-review')
    expect(row).toHaveTextContent('Review the staged diff')
    expect(row).toHaveTextContent('project .claude')
  })

  it('spells each source out the way 9b does', async () => {
    render(<Harness />)
    clickAndType(field(), '/co')
    await screen.findByRole('option', { name: /code-review/ })

    expect(screen.getByRole('option', { name: /coverage/ })).toHaveTextContent('user ~/.claude')
    expect(screen.getByRole('option', { name: /compact/ })).toHaveTextContent('built-in')
    expect(screen.getByRole('option', { name: /container-logs/ })).toHaveTextContent('plugin')
  })

  it('keeps focus in the field, wiring the active row through aria-activedescendant', async () => {
    render(<Harness />)
    clickAndType(field(), '/co')
    await screen.findByRole('option', { name: /code-review/ })

    expect(document.activeElement).toBe(field())
    const active = field().getAttribute('aria-activedescendant')
    expect(active).toBeTruthy()
    expect(document.getElementById(active!)).toBe(selectedRow())
    expect(field()).toHaveAttribute('aria-controls', popup()!.id)
  })
})

describe('CompletionPopup — files', () => {
  it('opens on an @ anywhere and asks the server for the typed prefix', async () => {
    render(<Harness />)
    clickAndType(field(), 'check @web/src/co')

    await screen.findByRole('option', { name: /composer\.tsx/ })
    expect(api.filesComplete).toHaveBeenLastCalledWith({ session: 's1' }, 'web/src/co')
  })

  it('puts directories first, with an accent slash and a DIR mark (canvas 9b)', async () => {
    render(<Harness />)
    clickAndType(field(), '@co')
    await screen.findByRole('option', { name: /components/ })

    expect(rows()[0]).toHaveAccessibleName(/components/)
    expect(rows()[0]).toHaveTextContent('DIR')
    expect(rows()[0].querySelector('[data-dir-slash]')).toHaveTextContent('/')
  })

  it('shows a file`s size and its parent directory', async () => {
    render(<Harness />)
    clickAndType(field(), '@web/src/co')
    const row = await screen.findByRole('option', { name: /composer\.tsx/ })

    expect(row).toHaveTextContent('13 KB')
    expect(row).toHaveTextContent('web/src/')
  })

  it('accepting a directory keeps the popup open, now listing inside it', async () => {
    render(<Harness />)
    clickAndType(field(), '@co')
    await screen.findByRole('option', { name: /components/ })

    fireEvent.keyDown(field(), { key: 'Enter' })
    // Inserted with its trailing slash and NO trailing space — the popup is
    // still completing (canvas 9b: the only case ⏎ does not close).
    expect(fieldValue(field())).toBe('@components/')
    await waitFor(() =>
      expect(api.filesComplete).toHaveBeenLastCalledWith({ session: 's1' }, 'components/')
    )
    expect(popup()).toBeInTheDocument()
  })

  it('accepting a file closes the popup and adds one trailing space', async () => {
    render(<Harness />)
    clickAndType(field(), '@web/src/comp')
    await screen.findByRole('option', { name: /composer\.tsx/ })

    // Row 0 is the directory; composer.tsx is the third row.
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(fieldValue(field())).toBe('@web/src/composer.tsx ')
    await waitFor(() => expect(popup()).toBeNull())
  })

  it('tints an accepted mention at once — accept IS the receipt', async () => {
    render(<Harness />)
    clickAndType(field(), '@web/src/comp')
    await screen.findByRole('option', { name: /composer\.tsx/ })

    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(field().querySelector('[data-token="mention"]')).toHaveTextContent(
      '@web/src/composer.tsx'
    )
  })

  it('closes when the server has nothing for the prefix', async () => {
    vi.mocked(api.filesComplete).mockResolvedValue([])
    render(<Harness />)
    clickAndType(field(), '@zzz')
    await waitFor(() => expect(api.filesComplete).toHaveBeenCalled())
    await waitFor(() => expect(popup()).toBeNull())
  })
})

describe('CompletionPopup — placement', () => {
  /**
   * jsdom measures nothing, so the well is given a rect low on the screen —
   * where both mounts' fields actually sit — and the popup is re-measured. The
   * only variable left is the `placement` prop.
   */
  function anchorLow() {
    const well = document.querySelector('[data-composer-well]') as HTMLElement
    well.getBoundingClientRect = () =>
      ({ left: 100, right: 518, top: 600, bottom: 620, width: 418, height: 20 }) as DOMRect
    fireEvent(window, new Event('resize'))
  }

  it('opens above the well on the panel floor (canvas 9b)', async () => {
    render(<Harness />)
    clickAndType(field(), '/co')
    await screen.findByRole('option', { name: /code-review/ })

    const shell = popup()!.closest('[data-completion-popup]') as HTMLElement
    // The row can be in the DOM before the popup listens for `resize`, so the
    // re-measure is retried until it lands.
    await waitFor(() => {
      anchorLow()
      expect(shell.dataset.placement).toBe('above')
    })
    // Width = the well's, one 8px gap clear of its top edge (9e).
    expect(shell.style.width).toBe('418px')
  })

  it('opens below the same field in the dialog mount (canvas 9d)', async () => {
    render(<Harness placement="below" enter="newline" variant="dialog" />)
    clickAndType(field(), '/co')
    await screen.findByRole('option', { name: /code-review/ })

    anchorLow()
    const shell = popup()!.closest('[data-completion-popup]') as HTMLElement
    expect(shell.dataset.placement).toBe('below')
  })
})

describe('Composer — the completion key', () => {
  it('shows the resting hint copy it was given', () => {
    render(<Harness />)
    expect(screen.getByText('⏎ send · ⇧⏎ newline · ⌘V paste image')).toBeInTheDocument()
  })

  it('asks by cwd when the mount has no session (the dialog)', async () => {
    render(<Harness sessionKey={{ cwd: '/work/web' }} />)
    clickAndType(field(), '/co')
    await screen.findByRole('option', { name: /code-review/ })
    expect(api.commands).toHaveBeenCalledWith({ cwd: '/work/web' })
  })
})
