import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { configureFileOpen, LONG_PRESS_MS, messageImages } from '../lib/fileOpen'
import { findPathMentions } from '../lib/pathLinks'
import type { ChatMessage } from '../lib/types'
import { useOrbital } from '../store/store'
import { MessageView } from '../panels/MessageView'

function assistant(text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', role: 'assistant', text, ...extra }
}

beforeEach(() => {
  useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null, fileViewer: null } }))
})

afterEach(() => {
  configureFileOpen(null)
  vi.useRealTimers()
})

describe('the open seam, unconfigured (the desktop)', () => {
  it('a press opens the desktop viewer and never a hook; a non-pressable path stays bare text', () => {
    render(<MessageView message={assistant('See web/src/App.tsx and out/lighthouse.pdf now.')} />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(document.querySelector('[data-path-plain]')).toBeNull()
    expect(screen.getByText(/out\/lighthouse\.pdf now\./)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'web/src/App.tsx' }))
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: 'web/src/App.tsx', line: null })
  })
})

describe('the open seam, configured (the phone)', () => {
  it('a press calls open with the path, its line and the message it came from', () => {
    const open = vi.fn()
    configureFileOpen({ open, longPress: vi.fn() })
    render(<MessageView message={assistant('Saved to /tmp/login.png and web/src/App.tsx:42.')} />)

    fireEvent.click(screen.getByRole('button', { name: '/tmp/login.png' }))
    fireEvent.click(screen.getByRole('button', { name: /web\/src\/App\.tsx/ }))
    expect(open.mock.calls).toEqual([
      [{ kind: 'path', path: '/tmp/login.png', line: null, messageId: 'm1' }],
      [{ kind: 'path', path: 'web/src/App.tsx', line: 42, messageId: 'm1' }],
    ])
    expect(useOrbital.getState().ui.fileViewer).toBeNull()
  })

  it('a non-pressable path gets the long-press but no press', () => {
    vi.useFakeTimers()
    const open = vi.fn()
    const longPress = vi.fn()
    configureFileOpen({ open, longPress })
    render(<MessageView message={assistant('The run is out/lighthouse.pdf.')} />)

    const plain = document.querySelector('[data-path-plain]') as HTMLElement
    expect(plain.textContent).toBe('out/lighthouse.pdf')
    expect(screen.queryAllByRole('button')).toHaveLength(0)

    fireEvent.click(plain)
    expect(open).not.toHaveBeenCalled()

    fireEvent.pointerDown(plain, { clientX: 0, clientY: 0 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS)
    })
    expect(longPress).toHaveBeenCalledWith('out/lighthouse.pdf')
  })

  it('a long-press on a link copies instead of opening', () => {
    vi.useFakeTimers()
    const open = vi.fn()
    const longPress = vi.fn()
    configureFileOpen({ open, longPress })
    render(<MessageView message={assistant('Notes in docs/parity/Button.md.')} />)

    const link = screen.getByRole('button', { name: 'docs/parity/Button.md' })
    fireEvent.pointerDown(link, { clientX: 0, clientY: 0 })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS)
    })
    fireEvent.pointerUp(link)
    fireEvent.click(link)
    expect(longPress).toHaveBeenCalledWith('docs/parity/Button.md')
    expect(open).not.toHaveBeenCalled()
  })
})

describe('messageImages', () => {
  it('lists the attached refs, then the image paths of agent text, each once', () => {
    const images = messageImages(
      assistant('Saved /tmp/a.png, then /tmp/notes.md and /tmp/b.webp; /tmp/a.png again.', {
        images: [{ ref: 'r1.png', w: 10, h: 10, bytes: 5 }],
      }),
    )
    expect(images.map((i) => (i.kind === 'ref' ? i.ref : i.path))).toEqual(['r1.png', '/tmp/a.png', '/tmp/b.webp'])
  })

  it('reads no paths out of a user turn, which shows none as links', () => {
    const images = messageImages({ role: 'user', text: 'look at /tmp/a.png' })
    expect(images).toEqual([])
  })
})

describe('findPathMentions', () => {
  it('finds every path with a file extension, pressable or not', () => {
    expect(findPathMentions('see out/lighthouse.pdf and web/App.tsx:3').map((m) => [m.path, m.line])).toEqual([
      ['out/lighthouse.pdf', null],
      ['web/App.tsx', 3],
    ])
  })

  it('leaves fractions, versions, bare words and URLs alone', () => {
    expect(findPathMentions('1/2.5 of v1.2/3.0 and/or https://x.com/a.pdf')).toEqual([])
  })
})
