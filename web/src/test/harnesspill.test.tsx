import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { HarnessPill } from '../panels/HarnessPill'
import { useOrbital } from '../store/store'
import { HARNESS_ENABLED_KEY } from '../lib/experimental'
import type { ApiSession, SessionHarness } from '../lib/types'

const session = { id: 's1', source: 'web' } as ApiSession

const harness = {
  sessionId: 's1',
  name: 'Checklist',
  steps: [{ id: 'a', title: 'First' }],
  state: [{ status: 'active' }],
  paused: false,
} as unknown as SessionHarness

/** The detail panel's shape: the pill first, the state row it follows in a later sibling. */
function Panel() {
  const stateRowRef = useRef<HTMLDivElement | null>(null)
  return (
    <div>
      <HarnessPill session={session} stateRowRef={stateRowRef} edge="over" />
      <div>
        <div ref={stateRowRef}>state</div>
      </div>
    </div>
  )
}

describe('HarnessPill', () => {
  beforeEach(() => {
    useOrbital.setState({ settings: { [HARNESS_ENABLED_KEY]: 'true' }, harnesses: {} })
  })

  it('shows once the harness is read after the panel opens', async () => {
    render(<Panel />)
    useOrbital.setState({ harnesses: { s1: harness } })
    expect(await screen.findByRole('button', { name: /^Harness:/ })).toBeTruthy()
  })

  it('shows when the panel opens on a session whose harness is already read', () => {
    useOrbital.setState({ harnesses: { s1: harness } })
    render(<Panel />)
    expect(screen.queryByRole('button', { name: /^Harness:/ })).toBeTruthy()
  })
})
