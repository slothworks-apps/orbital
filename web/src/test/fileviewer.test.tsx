import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import type { ApiSession, FilePreview } from '../lib/types'
import { useOrbital } from '../store/store'
import { PathButton } from '../panels/PathButton'

function makeSession(overrides: Partial<ApiSession> & { id: string }): ApiSession {
  return {
    cwd: '/home/tomin/work/platform/web',
    title: 'web-onboarding',
    firstAt: 1,
    lastAt: 100,
    messageCount: 1,
    source: 'web',
    permissionMode: null,
    model: null,
    resolvedModel: null,
    tagIds: [],
    status: 'idle',
    subagents: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useOrbital.setState((s) => ({
    ui: { ...s.ui, selectedId: null, fileViewer: null },
  }))
})

// ---------------------------------------------------------------------------
// PathButton
// ---------------------------------------------------------------------------

describe('PathButton', () => {
  it('opens the viewer with path and line on press', () => {
    render(<PathButton path="web/src/App.tsx" line={42} />)
    fireEvent.click(screen.getByRole('button'))
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: 'web/src/App.tsx', line: 42 })
  })

  it('stops propagation so the press never reaches the row', () => {
    const onRowClick = vi.fn()
    render(
      <div onClick={onRowClick}>
        <PathButton path="docs/readme.md" />
      </div>
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onRowClick).not.toHaveBeenCalled()
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: 'docs/readme.md', line: null })
  })

  it('renders the OPEN state for the file currently open, and pressing it is a no-op', () => {
    useOrbital.getState().openFile('web/src/App.tsx', 42)
    render(<PathButton path="web/src/App.tsx" line={7} />)

    const button = screen.getByRole('button')
    expect(button).toHaveAttribute('data-open', 'true')

    fireEvent.click(button)
    // Still the original target — the press changed nothing.
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: 'web/src/App.tsx', line: 42 })
  })

  it('is not in the OPEN state for a different open file', () => {
    useOrbital.getState().openFile('docs/readme.md')
    render(<PathButton path="web/src/App.tsx" />)
    expect(screen.getByRole('button')).not.toHaveAttribute('data-open')
  })
})

// ---------------------------------------------------------------------------
// PathButton — a bare name, and the right-click
// ---------------------------------------------------------------------------

describe('PathButton on a bare name', () => {
  const match = (relative: string, touched = false) => ({ path: `/home/tomin/work/platform/web/${relative}`, relative, touched })

  beforeEach(() => {
    const session = makeSession({ id: 's1' })
    useOrbital.setState((s) => ({ sessions: { ...s.sessions, s1: session }, ui: { ...s.ui, selectedId: 's1' } }))
  })

  it('opens the one match by its full path, carrying the line', async () => {
    vi.mocked(api.findFiles).mockResolvedValue({ matches: [match('src/lib/db/findAll.ts')], more: 0 })
    render(<PathButton path="findAll.ts" line={12} variant="code" bare />)
    fireEvent.click(screen.getByRole('button'))
    expect(api.findFiles).toHaveBeenCalledWith('s1', 'findAll.ts', undefined)
    await waitFor(() =>
      expect(useOrbital.getState().ui.fileViewer).toMatchObject({ path: match('src/lib/db/findAll.ts').path, line: 12 }),
    )
  })

  it('opens the name as written when a Mac without the lookup refuses it', async () => {
    vi.mocked(api.findFiles).mockResolvedValue(null)
    render(<PathButton path="findAll.ts" variant="code" bare />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(useOrbital.getState().ui.fileViewer).toMatchObject({ path: 'findAll.ts' }))
  })

  it('opens a chooser for several matches, in the server’s order, and a pick opens that file', async () => {
    vi.mocked(api.findFiles).mockResolvedValue({
      matches: [match('src/lib/db/findAll.ts', true), match('src/lib/cache/findAll.ts')],
      more: 0,
    })
    render(<PathButton path="findAll.ts" variant="code" bare />)
    fireEvent.click(screen.getByRole('button'))
    const rows = await screen.findAllByRole('menuitem')
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['src/lib/db/findAll.ts', 'src/lib/cache/findAll.ts'])
    expect(useOrbital.getState().ui.fileViewer).toBeNull()
    fireEvent.click(rows[1])
    expect(useOrbital.getState().ui.fileViewer).toMatchObject({ path: match('src/lib/cache/findAll.ts').path })
  })

  it('lists every match once its +N more row is picked, and counts only what the server left out', async () => {
    const many = Array.from({ length: 9 }, (_, i) => match(`p${i}/index.ts`))
    vi.mocked(api.findFiles).mockResolvedValue({ matches: many, more: 4 })
    render(<PathButton path="index.ts" variant="code" bare />)
    fireEvent.click(screen.getByRole('button'))
    const rows = await screen.findAllByRole('menuitem')
    expect(rows).toHaveLength(7)
    expect(rows[6]).toHaveAccessibleName('+7 more')
    fireEvent.click(rows[6])
    expect(screen.getAllByRole('menuitem')).toHaveLength(9)
    expect(screen.getByText('+4 more not listed · ask for the full path')).toBeInTheDocument()
    expect(useOrbital.getState().ui.fileViewer).toBeNull()
  })

  it('says there is no such file in the same popup, with nothing to pick', async () => {
    vi.mocked(api.findFiles).mockResolvedValue({ matches: [], more: 0 })
    render(<PathButton path="findAll.tsx" variant="code" bare />)
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByText('no file by that name under web/')).toBeInTheDocument()
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
  })

  it('on a right-click shows the chooser first, and a pick swaps in its actions with Back', async () => {
    vi.mocked(api.findFiles).mockResolvedValue({
      matches: [match('src/lib/db/findAll.ts', true), match('src/lib/cache/findAll.ts')],
      more: 0,
    })
    render(<PathButton path="findAll.ts" variant="code" bare />)
    const notDefault = fireEvent.contextMenu(screen.getByRole('button'))
    expect(notDefault).toBe(false)
    const rows = await screen.findAllByRole('menuitem')
    fireEvent.click(rows[0])
    const actions = screen.getAllByRole('menuitem').map((row) => row.textContent)
    expect(actions[0]).toContain('Back')
    expect(actions).toEqual(expect.arrayContaining(['‹Back', 'Copy path', 'Copy relative path']))
  })
})

describe('PathButton right-click', () => {
  beforeEach(() => {
    const session = makeSession({ id: 's1' })
    useOrbital.setState((s) => ({ sessions: { ...s.sessions, s1: session }, ui: { ...s.ui, selectedId: 's1' } }))
  })

  it('opens the menu for the located file, and Copy relative path measures from the working tree', async () => {
    vi.mocked(api.locateFile).mockResolvedValue('/home/tomin/work/platform/web/src/App.tsx')
    render(<PathButton path="src/App.tsx" />)
    expect(fireEvent.contextMenu(screen.getByRole('button'))).toBe(false)
    const labels = (await screen.findAllByRole('menuitem')).map((row) => row.textContent)
    expect(labels).toEqual(['Copy path', 'Copy relative path', 'Mention in reply'])
    expect(screen.getAllByRole('separator')).toHaveLength(1)
  })

  it('without a located file offers the path as written, with no relative row', async () => {
    vi.mocked(api.locateFile).mockResolvedValue(null)
    render(<PathButton path="src/App.tsx" />)
    fireEvent.contextMenu(screen.getByRole('button'))
    const labels = (await screen.findAllByRole('menuitem')).map((row) => row.textContent)
    expect(labels).toEqual(['Copy path', 'Mention in reply'])
  })
})

// ---------------------------------------------------------------------------
// FileViewer
// ---------------------------------------------------------------------------

import {
  FileViewer,
  HIGHLIGHT_MAX_BYTES,
  HIGHLIGHT_MAX_LINES,
  LOADING_SKELETON_DELAY_MS,
} from '../panels/FileViewer'

function okPreview(overrides: Partial<Extract<FilePreview, { kind: 'ok' }>> = {}): FilePreview {
  const content = overrides.content ?? 'const a = 1\nconst b = 2\nconst c = 3'
  return {
    kind: 'ok',
    content,
    size: content.length,
    mtimeMs: Date.now() - 120_000,
    lines: content.split('\n').length,
    ...overrides,
  }
}

function renderViewer(path: string, line: number | null = null, session = makeSession({ id: 's1' })) {
  useOrbital.getState().openFile(path, line)
  return render(<FileViewer session={session} />)
}

describe('FileViewer', () => {
  it('shows a real header from the first frame — path known, meta reading…, no skeleton yet', () => {
    vi.mocked(api.filePreview).mockReturnValue(new Promise(() => {}))
    renderViewer('web/src/App.tsx', 42)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(screen.getByText('App.tsx')).toBeInTheDocument()
    expect(screen.getByText('web/src/')).toBeInTheDocument()
    expect(screen.getByText(':42')).toBeInTheDocument()
    expect(screen.getByText('reading…')).toBeInTheDocument()
    // The skeleton waits out LOADING_SKELETON_DELAY_MS.
    expect(dialog.querySelector('[data-skeleton]')).toBeNull()
  })

  it('shows the skeleton only after LOADING_SKELETON_DELAY_MS', () => {
    vi.useFakeTimers()
    try {
      vi.mocked(api.filePreview).mockReturnValue(new Promise(() => {}))
      renderViewer('web/src/App.tsx')

      const dialog = screen.getByRole('dialog')
      act(() => {
        vi.advanceTimersByTime(LOADING_SKELETON_DELAY_MS - 20)
      })
      expect(dialog.querySelector('[data-skeleton]')).toBeNull()
      act(() => {
        vi.advanceTimersByTime(40)
      })
      expect(dialog.querySelector('[data-skeleton]')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders markdown files through the transcript pipeline, not as source rows', async () => {
    vi.mocked(api.filePreview).mockResolvedValue(okPreview({ content: '# Clickable paths\n\nbody' }))
    renderViewer('docs/ideas/clickable-file-paths.md')

    expect(await screen.findByRole('heading', { name: 'Clickable paths' })).toBeInTheDocument()
    expect(screen.getByRole('dialog').querySelector('[data-line]')).toBeNull()
  })

  it('renders source files as gutter rows, one per line', async () => {
    vi.mocked(api.filePreview).mockResolvedValue(okPreview())
    renderViewer('web/src/App.tsx')

    await waitFor(() =>
      expect(screen.getByRole('dialog').querySelectorAll('[data-line]')).toHaveLength(3)
    )
    expect(screen.getByText('const a = 1')).toBeInTheDocument()
  })

  it('keeps line numbers out of the text a selection copies', async () => {
    vi.mocked(api.filePreview).mockResolvedValue(okPreview())
    renderViewer('web/src/App.tsx')

    await waitFor(() =>
      expect(screen.getByRole('dialog').querySelectorAll('[data-line]')).toHaveLength(3)
    )
    const rows = [...screen.getByRole('dialog').querySelectorAll('[data-line]')]
    expect(rows.map((row) => row.textContent)).toEqual(['const a = 1', 'const b = 2', 'const c = 3'])
  })

  it('marks the target line, and only it', async () => {
    vi.mocked(api.filePreview).mockResolvedValue(okPreview())
    renderViewer('web/src/App.tsx', 2)

    await waitFor(() =>
      expect(screen.getByRole('dialog').querySelectorAll('[data-target-line]')).toHaveLength(1)
    )
    expect(
      screen.getByRole('dialog').querySelector('[data-target-line]')
    ).toHaveAttribute('data-line', '2')
  })

  it('degrades to one plain <pre> over HIGHLIGHT_MAX_BYTES', async () => {
    vi.mocked(api.filePreview).mockResolvedValue(okPreview({ size: HIGHLIGHT_MAX_BYTES + 1 }))
    renderViewer('web/src/App.tsx', 2)

    await waitFor(() =>
      expect(screen.getByRole('dialog').querySelector('[data-degraded]')).toBeInTheDocument()
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('[data-line]')).toBeNull()
    expect(dialog.querySelector('[data-target-line]')).toBeNull()
  })

  it('degrades over HIGHLIGHT_MAX_LINES too, even for markdown', async () => {
    vi.mocked(api.filePreview).mockResolvedValue(
      okPreview({ content: '# big', lines: HIGHLIGHT_MAX_LINES + 1 })
    )
    renderViewer('docs/big.md')

    await waitFor(() =>
      expect(screen.getByRole('dialog').querySelector('[data-degraded]')).toBeInTheDocument()
    )
    expect(screen.queryByRole('heading')).toBeNull()
  })

  it('shows the OUTSIDE SESSION FOLDER refusal with the session cwd', async () => {
    vi.mocked(api.filePreview).mockResolvedValue({ kind: 'outside' })
    renderViewer('~/.ssh/config')

    expect(await screen.findByText('OUTSIDE SESSION FOLDER')).toBeInTheDocument()
    expect(screen.getByText(/Orbital reads inside.*and files this session named/)).toBeInTheDocument()
    expect(screen.getByText('/home/tomin/work/platform/web')).toBeInTheDocument()
    expect(screen.getByText('not read')).toBeInTheDocument()
  })

  it('shows NO LONGER ON DISK for a missing file', async () => {
    vi.mocked(api.filePreview).mockResolvedValue({ kind: 'not_found' })
    renderViewer('web/src/gone.ts')

    expect(await screen.findByText('NO LONGER ON DISK')).toBeInTheDocument()
  })

  it('names the measured size against the ceiling for TOO LARGE', async () => {
    vi.mocked(api.filePreview).mockResolvedValue({ kind: 'too_large', size: 12 * 1024 * 1024 })
    renderViewer('tmp/build.log')

    expect(await screen.findByText('TOO LARGE TO PREVIEW')).toBeInTheDocument()
    expect(screen.getByText(/over the/)).toHaveTextContent('12 MB over the 10 MB ceiling.')
  })

  it('shows the media type for BINARY', async () => {
    vi.mocked(api.filePreview).mockResolvedValue({
      kind: 'binary',
      size: 131_072,
      mediaType: 'font/woff2',
    })
    renderViewer('public/fonts/Manrope.woff2')

    expect(await screen.findByText('BINARY FILE')).toBeInTheDocument()
    expect(screen.getByText(/nothing to read as text/)).toHaveTextContent(
      'font/woff2 — nothing to read as text.'
    )
  })

  it('escape closes the viewer', async () => {
    vi.mocked(api.filePreview).mockResolvedValue(okPreview())
    renderViewer('web/src/App.tsx')
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })

    expect(useOrbital.getState().ui.fileViewer).toBeNull()
  })

  it('the × and the backdrop both close it', async () => {
    vi.mocked(api.filePreview).mockResolvedValue(okPreview())
    renderViewer('web/src/App.tsx')
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(useOrbital.getState().ui.fileViewer).toBeNull()
  })

  it('shows the footer sentence and where it was opened from', async () => {
    vi.mocked(api.filePreview).mockResolvedValue(okPreview())
    renderViewer('web/src/App.tsx')

    await waitFor(() => expect(screen.getByText(/read-only snapshot/)).toBeInTheDocument())
    expect(screen.getByText('esc')).toBeInTheDocument()
    expect(screen.getByText(/opened from web-onboarding/)).toBeInTheDocument()
  })
})
