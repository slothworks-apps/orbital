import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// ---------------------------------------------------------------------------
// This file is about ONE thing: where App puts its error boundaries. Every
// child is stubbed so a crash can be aimed at exactly one docked panel and
// the others' survival is unambiguous — app.test.tsx is the file that renders
// the real tree.
// ---------------------------------------------------------------------------
vi.mock('../map/SpaceMap', () => ({ SpaceMap: () => <div>space map</div> }))
vi.mock('../panels/Sidebar', () => ({ Sidebar: () => <div>sidebar</div> }))
vi.mock('../panels/DetailPanel', () => ({
  DetailPanel: () => {
    throw new Error('sourceOptions is not defined')
  },
}))
vi.mock('../panels/NewSessionDialog', () => ({ NewSessionDialog: () => null }))
vi.mock('../panels/Settings', () => ({ Settings: () => null }))
vi.mock('../ui/Toasts', () => ({ Toasts: () => null }))
vi.mock('../lib/ws', () => ({
  resolveWsUrl: () => 'ws://test/ws',
  OrbitalSocket: class {
    subscribe() {
      return () => {}
    }
    onStatusChange(cb: (status: string) => void) {
      cb('open')
      return () => {}
    }
  },
}))
vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import App from '../App'

beforeAll(() => {
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = NoopObserver
  // @ts-expect-error jsdom doesn't implement this one at all (no ambient type)
  global.IntersectionObserver = NoopObserver
})

// Only what App's mount-time `loadInitial()` reads — everything else on `api`
// resolves to undefined and nothing here calls it.
beforeEach(() => {
  vi.mocked(api.listSessions).mockResolvedValue([])
  vi.mocked(api.listTags).mockResolvedValue([])
  vi.mocked(api.listTagRules).mockResolvedValue([])
  vi.mocked(api.getSettings).mockResolvedValue({})
  vi.mocked(api.listModels).mockResolvedValue([])
  vi.mocked(api.listErrors).mockResolvedValue({ errors: [], unseen: 0 })
  // The boundary that catches below records the crash, and `restoreAllMocks`
  // strips apiMock's resolving default between tests.
  vi.mocked(api.reportErrorToServer).mockResolvedValue({
    error: {
      id: 1,
      at: 1,
      source: 'web',
      kind: 'render_crash',
      sessionId: null,
      message: 'sourceOptions is not defined',
      detail: null,
      context: null,
      seenAt: null,
    },
    unseen: 1,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('App error boundaries', () => {
  it('keeps the rest of the shell alive when one docked panel throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<App />)

    expect(screen.getByRole('alert')).toHaveTextContent('Detail panel')
    expect(screen.getByText('sidebar')).toBeInTheDocument()
    expect(screen.getByText('space map')).toBeInTheDocument()
  })
})
