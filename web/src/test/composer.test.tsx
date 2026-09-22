import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { Composer, FIELD_METRICS, type ComposerProps } from '../panels/Composer'
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
const mirror = () => document.querySelector('[data-composer-mirror]') as HTMLElement
const popup = () => screen.queryByRole('listbox', { name: /completions/i })
const rows = () => screen.queryAllByRole('option')
const selectedRow = () => rows().find((r) => r.dataset.selected === 'true')

/** Types into the field and keeps the caret where a user's would be. */
async function type(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(field())
  await user.type(field(), text)
}

beforeEach(() => {
  vi.mocked(api.commands).mockResolvedValue(COMMANDS)
  vi.mocked(api.filesComplete).mockResolvedValue(ENTRIES)
})

// ---------------------------------------------------------------------------
// The well + the mirror (canvas 9a)
// ---------------------------------------------------------------------------

describe('Composer — the mirrored highlight layer', () => {
  it('renders the text twice: once in the field, once in an aria-hidden mirror', () => {
    render(<Harness initial="plain prose" />)
    expect(field()).toHaveValue('plain prose')
    expect(mirror()).toHaveAttribute('aria-hidden', 'true')
    expect(mirror().textContent).toBe('plain prose')
  })

  it('keeps the mirror and the field on identical metrics — the lockstep guarantee', () => {
    render(<Harness initial="x" />)
    for (const cls of FIELD_METRICS.split(' ')) {
      expect(mirror().className).toContain(cls)
      expect(field().className).toContain(cls)
    }
  })

  it('leaves the mirror text untouched while marking a known command token', async () => {
    render(<Harness initial="/code-review the staged diff" />)
    await waitFor(() => expect(mirror().querySelector('[data-token="command"]')).not.toBeNull())
    expect(mirror().textContent).toBe('/code-review the staged diff')
    expect(mirror().querySelector('[data-token="command"]')).toHaveTextContent('/code-review')
  })

  it('marks a command wherever it starts a word, and leaves an unknown slug plain', async () => {
    render(<Harness initial="/commit then run /code-review and /comand" />)
    await waitFor(() =>
      expect(mirror().querySelectorAll('[data-token="command"]')).toHaveLength(2)
    )
    const marked = [...mirror().querySelectorAll('[data-token="command"]')].map((n) => n.textContent)
    expect(marked).toEqual(['/commit', '/code-review'])
    expect(mirror().textContent).toBe('/commit then run /code-review and /comand')
  })

  it('tints a hand-typed mention once the debounced probe confirms the path', async () => {
    const user = userEvent.setup()
    vi.mocked(api.filesComplete).mockResolvedValue([{ name: 'App.tsx', dir: false, size: 10 }])
    render(<Harness />)
    await type(user, 'from @web/src/App.tsx:42 ')

    const token = await waitFor(() => {
      const el = mirror().querySelector('[data-token="mention"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    expect(token).toHaveTextContent('@web/src/App.tsx:42')
    expect(token.querySelector('[data-token-suffix]')).toHaveTextContent(':42')
    expect(mirror().textContent).toBe('from @web/src/App.tsx:42 ')
  })

  it('leaves a mention the server does not know plain — the tint is a receipt', async () => {
    const user = userEvent.setup()
    vi.mocked(api.filesComplete).mockResolvedValue([])
    render(<Harness />)
    await type(user, 'from @web/src/Nope.tsx ')

    await waitFor(() =>
      expect(api.filesComplete).toHaveBeenCalledWith({ session: 's1' }, 'web/src/Nope.tsx')
    )
    expect(mirror().querySelector('[data-token="mention"]')).toBeNull()
    expect(mirror().textContent).toBe('from @web/src/Nope.tsx ')
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
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/co')
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
  it('sends on ⏎ and newlines on ⇧⏎ in the panel mount', async () => {
    const onSend = vi.fn()
    render(<Harness initial="line one" onSend={onSend} />)

    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('line one')
  })

  it('newlines on ⏎ in the dialog mount and never sends', () => {
    const onSend = vi.fn()
    render(<Harness initial="line one" enter="newline" onSend={onSend} />)

    const e = fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    // Not swallowed: the textarea's own newline has to happen.
    expect(e).toBe(true)
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
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/')

    expect(await screen.findByRole('option', { name: /code-review/ })).toBeInTheDocument()
    expect(api.commands).toHaveBeenCalledWith({ session: 's1' })
    expect(popup()).toBeInTheDocument()
  })

  it('opens on a / that starts a word later in the prompt', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, 'then run /co')
    await screen.findByRole('option', { name: /code-review/ })
  })

  it('inserts a command accepted mid-prompt in place, leaving the prose alone', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, 'then run /code-r')
    await screen.findByRole('option', { name: /code-review/ })
    fireEvent.keyDown(field(), { key: 'Enter' })
    await waitFor(() => expect(field()).toHaveValue('then run /code-review '))
  })

  it('prefix-filters as you type, resetting the selection to the first row', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/co')
    await screen.findByRole('option', { name: /code-review/ })
    expect(rows()).toHaveLength(6)

    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(selectedRow()).toHaveAccessibleName(/\/commit/)

    // `/com` narrows to commit + compact, and the selection goes back to row 0.
    await user.type(field(), 'm')
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(selectedRow()).toHaveAccessibleName(/\/commit/)
  })

  it('wraps the selection at both ends', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/cost')
    await waitFor(() => expect(rows()).toHaveLength(1))

    // A single row wraps onto itself in both directions.
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(selectedRow()).toHaveAccessibleName(/\/cost/)
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(selectedRow()).toHaveAccessibleName(/\/cost/)

    await user.clear(field())
    await user.type(field(), '/com')
    await waitFor(() => expect(rows()).toHaveLength(2))
    // Up from the top lands on the last row, down from there wraps home.
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(selectedRow()).toHaveAccessibleName(/\/compact/)
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(selectedRow()).toHaveAccessibleName(/\/commit/)
  })

  it('accepts on ⏎, replacing the fragment and adding one trailing space', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/comm')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(field()).toHaveValue('/commit ')
    await waitFor(() => expect(popup()).toBeNull())
  })

  it('accepts on Tab too, and Tab does not move focus out of the field', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/comm')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.keyDown(field(), { key: 'Tab' })
    expect(field()).toHaveValue('/commit ')
    expect(document.activeElement).toBe(field())
  })

  it('does not send when ⏎ is the popup`s — the accept is not a turn', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Harness onSend={onSend} />)
    await type(user, '/comm')
    await waitFor(() => expect(rows()).toHaveLength(1))

    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('closes on Escape, one layer only, leaving the text and the focus alone', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const before = escapeLayerDepth()
    await type(user, '/co')
    await waitFor(() => expect(escapeLayerDepth()).toBe(before + 1))

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(popup()).toBeNull())
    expect(escapeLayerDepth()).toBe(before)
    expect(field()).toHaveValue('/co')
    expect(document.activeElement).toBe(field())
  })

  it('stays closed after Escape until the trigger is typed again', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/co')
    await screen.findByRole('option', { name: /code-review/ })
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(popup()).toBeNull())

    await user.type(field(), 'm')
    await waitFor(() => expect(popup()).toBeNull())
  })

  it('closes when ⌫ takes the caret back past the trigger', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/c')
    await screen.findByRole('option', { name: /code-review/ })

    await user.type(field(), '{Backspace}{Backspace}')
    await waitFor(() => expect(popup()).toBeNull())
    expect(field()).toHaveValue('')
  })

  it('closes on no match rather than showing an empty shell', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/co')
    await screen.findByRole('option', { name: /code-review/ })

    await user.type(field(), 'mand')
    await waitFor(() => expect(popup()).toBeNull())
    expect(rows()).toHaveLength(0)
  })

  it('carries a name, a description and a source badge per row (canvas 9b)', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/co')
    const row = await screen.findByRole('option', { name: /code-review/ })

    expect(row).toHaveTextContent('/code-review')
    expect(row).toHaveTextContent('Review the staged diff')
    expect(row).toHaveTextContent('project .claude')
  })

  it('spells each source out the way 9b does', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/co')
    await screen.findByRole('option', { name: /code-review/ })

    expect(screen.getByRole('option', { name: /coverage/ })).toHaveTextContent('user ~/.claude')
    expect(screen.getByRole('option', { name: /compact/ })).toHaveTextContent('built-in')
    expect(screen.getByRole('option', { name: /container-logs/ })).toHaveTextContent('plugin')
  })

  it('keeps focus in the field, wiring the active row through aria-activedescendant', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/co')
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
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, 'check @web/src/co')

    await screen.findByRole('option', { name: /composer\.tsx/ })
    expect(api.filesComplete).toHaveBeenLastCalledWith({ session: 's1' }, 'web/src/co')
  })

  it('puts directories first, with an accent slash and a DIR mark (canvas 9b)', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '@co')
    await screen.findByRole('option', { name: /components/ })

    expect(rows()[0]).toHaveAccessibleName(/components/)
    expect(rows()[0]).toHaveTextContent('DIR')
    expect(rows()[0].querySelector('[data-dir-slash]')).toHaveTextContent('/')
  })

  it('shows a file`s size and its parent directory', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '@web/src/co')
    const row = await screen.findByRole('option', { name: /composer\.tsx/ })

    expect(row).toHaveTextContent('13 KB')
    expect(row).toHaveTextContent('web/src/')
  })

  it('accepting a directory keeps the popup open, now listing inside it', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '@co')
    await screen.findByRole('option', { name: /components/ })

    fireEvent.keyDown(field(), { key: 'Enter' })
    // Inserted with its trailing slash and NO trailing space — the popup is
    // still completing (canvas 9b: the only case ⏎ does not close).
    expect(field()).toHaveValue('@components/')
    await waitFor(() =>
      expect(api.filesComplete).toHaveBeenLastCalledWith({ session: 's1' }, 'components/')
    )
    expect(popup()).toBeInTheDocument()
  })

  it('accepting a file closes the popup and adds one trailing space', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '@web/src/comp')
    await screen.findByRole('option', { name: /composer\.tsx/ })

    // Row 0 is the directory; composer.tsx is the third row.
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(field()).toHaveValue('@web/src/composer.tsx ')
    await waitFor(() => expect(popup()).toBeNull())
  })

  it('tints an accepted mention at once — accept IS the receipt', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '@web/src/comp')
    await screen.findByRole('option', { name: /composer\.tsx/ })

    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(mirror().querySelector('[data-token="mention"]')).toHaveTextContent(
      '@web/src/composer.tsx'
    )
  })

  it('closes when the server has nothing for the prefix', async () => {
    const user = userEvent.setup()
    vi.mocked(api.filesComplete).mockResolvedValue([])
    render(<Harness />)
    await type(user, '@zzz')
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
    const user = userEvent.setup()
    render(<Harness />)
    await type(user, '/co')
    await screen.findByRole('option', { name: /code-review/ })

    anchorLow()
    const shell = popup()!.closest('[data-completion-popup]') as HTMLElement
    expect(shell.dataset.placement).toBe('above')
    // Width = the well's, one 8px gap clear of its top edge (9e).
    expect(shell.style.width).toBe('418px')
  })

  it('opens below the same field in the dialog mount (canvas 9d)', async () => {
    const user = userEvent.setup()
    render(<Harness placement="below" enter="newline" variant="dialog" />)
    await type(user, '/co')
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
    const user = userEvent.setup()
    render(<Harness sessionKey={{ cwd: '/work/web' }} />)
    await type(user, '/co')
    await screen.findByRole('option', { name: /code-review/ })
    expect(api.commands).toHaveBeenCalledWith({ cwd: '/work/web' })
  })
})
