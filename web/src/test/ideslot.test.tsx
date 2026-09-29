import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { Composer, type ComposerProps } from '../panels/Composer'
import { MessageView } from '../panels/MessageView'
import { promptWithSelection, selectionId } from '../lib/ideSelection'
import { useOrbital } from '../store/store'
import { IDE_SELECTION_DEBOUNCE_MS } from '../lib/useIdeReadout'
import type { FileCompletionEntry, IdeContext } from '../lib/types'
import { fieldValue, focusField } from './composerField'

/**
 * The composer's editor slot (spec: 2026-09-23-ide-bridge-design; canvas
 * `Feature - IDE bridge` 20a/20b/20c).
 *
 * Deliberately no styling values: canvas fidelity is checked against Claude
 * Design during the work, never frozen into the suite (CLAUDE.md § Tests).
 * What is pinned here is the no-editor paths, the ×'s wiring, the ranking the
 * popup draws, and the structural invariant that the slot's clip is not an
 * ancestor of the popup.
 */

const SELECTION = {
  filePath: '/w/x/web/CLAUDE.md',
  lineStart: 84,
  lineCount: 5,
  text: 'five lines',
}

function ide(over: Partial<IdeContext> = {}): IdeContext {
  return { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: SELECTION, ...over }
}

const slot = () => document.querySelector<HTMLElement>('[data-ide-slot]')
const field = () => screen.getByRole('textbox', { name: 'Prompt' })

/** Controlled wrapper — both real mounts own the draft, so the harness does too. */
function Harness({ initial = '', ...props }: Partial<ComposerProps> & { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <Composer
      sessionKey={{ session: 's1' }}
      value={value}
      onChange={setValue}
      enter="send"
      placement="above"
      variant="panel"
      hint="⏎ send · ⇧⏎ newline · ⌘V paste image"
      aria-label="Prompt"
      {...props}
    />
  )
}

describe('the editor slot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('draws nothing at all when there is no editor', () => {
    render(<Harness />)
    expect(slot()).toBeNull()
  })

  it('draws nothing while the editor is open but has not said where the caret is', () => {
    // `selection_changed` only fires when the caret moves, so between
    // connecting and the first click in the editor there is no reading. The
    // slot rides on having one, not on the connection — otherwise it stands
    // there holding a caret glyph, a blank and the editor's name.
    render(<Harness ide={ide({ selection: null })} />)
    expect(slot()).toBeNull()
  })

  it('reads out the caret with nothing to drop, when nothing is selected', () => {
    render(<Harness ide={ide({ selection: { ...SELECTION, text: null } })} />)
    expect(slot()?.dataset.state).toBe('cursor')
    expect(screen.queryByRole('button', { name: /drop the editor selection/i })).toBeNull()
    // The file NAME alone, never the directory (canvas 20b-2).
    expect(slot()?.textContent).toContain('CLAUDE.md:84')
    expect(slot()?.textContent).not.toContain('web/CLAUDE.md')
    expect(slot()?.textContent).toContain('WebStorm')
  })

  it('raises a lip once the selection settles, in the CLI wording', () => {
    vi.useFakeTimers()
    try {
      render(<Harness ide={ide()} />)
      act(() => {
        vi.advanceTimersByTime(IDE_SELECTION_DEBOUNCE_MS)
      })
      expect(slot()?.dataset.state).toBe('selection')
      expect(slot()?.textContent).toContain('Selected 5 lines from CLAUDE.md')
    } finally {
      vi.useRealTimers()
    }
  })

  it('names what ⏎ will carry in the hint line', async () => {
    render(<Harness ide={ide()} />)
    await screen.findByText(/⏎ send with 5 lines · ⇧⏎ newline/)
  })

  it('× reports the selection it was standing over, and then the lip sinks', async () => {
    const onIdeDismiss = vi.fn()

    function Wrapper() {
      const [dismissedId, setDismissedId] = useState<string | undefined>(undefined)
      return (
        <Harness
          ide={ide()}
          ideDismissedId={dismissedId}
          onIdeDismiss={(id) => {
            onIdeDismiss(id)
            setDismissedId(id)
          }}
        />
      )
    }

    render(<Wrapper />)
    const drop = await screen.findByRole('button', { name: /drop the editor selection/i })
    await userEvent.click(drop)

    expect(onIdeDismiss).toHaveBeenCalledWith(selectionId(SELECTION))
    // Back to the cursor line, not gone: the editor is still there.
    await waitFor(() => expect(slot()?.dataset.state).toBe('cursor'))
  })

  it('does not clip the completion popup it shares a well with', async () => {
    vi.mocked(api.filesComplete).mockResolvedValue([{ name: 'app.ts', dir: false, size: 1 }])
    render(<Harness initial="@a" ide={ide()} />)
    const list = await screen.findByRole('listbox', { name: /completions/i })

    // jsdom lays nothing out and clips nothing, so this asserts the invariant
    // structurally instead: no ancestor of the popup may carry the clip that
    // makes the slot slide out from behind the well's edge (web/CLAUDE.md).
    // The popup's own root clips its scroll area, which is its business; the
    // invariant is about what sits between it and the well.
    for (let el = list.parentElement?.parentElement; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)overflow-hidden(\s|$)/)
    }
    expect(slot()?.className).toMatch(/overflow-hidden/)
  })
})

describe('the completion list with an editor connected', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /** As the server ranks them: the active tab, the other tabs, then the walk. */
  const RANKED: FileCompletionEntry[] = [
    {
      name: 'DetailPanel.tsx',
      dir: false,
      path: 'web/src/panels/DetailPanel.tsx',
      open: true,
      active: true,
      line: 88,
    },
    { name: 'Deploy.md', dir: false, path: 'server/Deploy.md', open: true },
    { name: 'docs', dir: true },
    { name: 'Deferred.md', dir: false, size: 30 },
  ]

  const rowsOf = () => screen.getAllByRole('option').map((r) => r.textContent ?? '')

  it('keeps the open tabs above the directories the walk found', async () => {
    vi.mocked(api.filesComplete).mockResolvedValue(RANKED)
    render(<Harness initial="@De" />)
    await screen.findByRole('listbox', { name: /completions/i })
    const rows = rowsOf()
    // A file ranked above a directory is the ranking doing its job — nothing
    // else in this list can produce that order.
    expect(rows[0]).toContain('DetailPanel.tsx')
    expect(rows[1]).toContain('Deploy.md')
    expect(rows[2]).toContain('docs')
    expect(rows[3]).toContain('Deferred.md')
  })

  it('says OPEN instead of a size, and the caret line on the active tab', async () => {
    vi.mocked(api.filesComplete).mockResolvedValue(RANKED)
    render(<Harness initial="@De" />)
    await screen.findByRole('listbox', { name: /completions/i })
    const rows = rowsOf()
    expect(rows[0]).toContain('OPEN · :88')
    expect(rows[1]).toContain('OPEN')
    expect(rows[1]).not.toContain(':88')
    // An ordinary row is still weighed.
    expect(rows[3]).not.toContain('OPEN')
    expect(rows[3]).toMatch(/\d/)
  })

  it('counts the open rows in the head', async () => {
    vi.mocked(api.filesComplete).mockResolvedValue(RANKED)
    render(<Harness initial="@De" />)
    await screen.findByRole('listbox', { name: /completions/i })
    expect(screen.getByText(/2 OPEN ·/)).toBeTruthy()
  })

  it('inserts an open tab by its own path, not by the typed directory', async () => {
    vi.mocked(api.filesComplete).mockResolvedValue(RANKED)
    render(<Harness initial="@De" />)
    // The caret is where the accept splices: in the real app the field has
    // focus and the caret sits at the end of the fragment being completed.
    focusField(field())
    await screen.findByRole('listbox', { name: /completions/i })
    await userEvent.click(screen.getAllByRole('option')[0])
    expect(fieldValue(field())).toBe('@web/src/panels/DetailPanel.tsx ')
  })

  it('draws the shipped list unchanged when nothing is open', async () => {
    vi.mocked(api.filesComplete).mockResolvedValue([
      { name: 'docs', dir: true },
      { name: 'Deferred.md', dir: false, size: 30 },
    ])
    render(<Harness initial="@De" />)
    await screen.findByRole('listbox', { name: /completions/i })
    expect(rowsOf()[0]).toContain('docs')
    expect(rowsOf().some((r) => r.includes('OPEN'))).toBe(false)
    // No count in the head either.
    expect(screen.queryByText(/OPEN ·/)).toBeNull()
  })
})

describe('the sent turn', () => {
  const turn = (text: string) => ({
    id: 'm1',
    role: 'user' as const,
    text,
    timestamp: '2026-09-23T10:00:00Z',
  })

  it('shows what was typed, with the range as a caption under the bubble', () => {
    render(<MessageView message={turn(promptWithSelection('tighten this', '/w/x', SELECTION))} />)
    // The block itself is what the model reads, not what the person re-reads.
    expect(screen.queryByText(/Selected in the editor/)).toBeNull()
    expect(screen.getByText('tighten this')).toBeTruthy()

    const caption = document.querySelector('[data-sent-selection]') as HTMLElement
    expect(caption.textContent).toContain('5 lines from')
    expect(caption.textContent).toContain('CLAUDE.md')
    expect(caption.textContent).toContain(':84–88')
  })

  it('opens the file viewer at the first selected line', async () => {
    render(<MessageView message={turn(promptWithSelection('why?', '/w/x', SELECTION))} />)
    await userEvent.click(document.querySelector('[data-sent-selection]') as HTMLElement)
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: 'web/CLAUDE.md', line: 84 })
  })

  it('leaves an ordinary turn exactly as it was', () => {
    render(<MessageView message={turn('just a message')} />)
    expect(document.querySelector('[data-sent-selection]')).toBeNull()
    expect(screen.getByText('just a message')).toBeTruthy()
  })
})
