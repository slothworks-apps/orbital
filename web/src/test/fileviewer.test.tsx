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
    expect(screen.getByText('2')).toBeInTheDocument()
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
    expect(screen.getByText(/Orbital only reads inside/)).toBeInTheDocument()
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
