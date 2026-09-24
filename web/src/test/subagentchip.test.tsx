import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Subagent } from '../lib/types'
import { useOrbital } from '../store/store'
import { SubagentChip } from '../panels/SubagentChip'

// A store action reached by accident resolves instead of throwing.
vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

// ---------------------------------------------------------------------------
// The detail header's subagent chip (subagent list spec §§ 1, 2): what it
// wires, not how it looks — the counts, groups and order are
// `lib/subagentList`'s and tested there.
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-1'

function agent(id: string, overrides: Partial<Subagent> = {}): Subagent {
  return { id, name: `Task ${id}`, state: 'working', toolUseId: `tool-${id}`, startedAt: 0, ...overrides }
}

const initial = useOrbital.getState()
// Unmount first: resetting the store under a mounted chip is an update outside act.
afterEach(() => {
  cleanup()
  useOrbital.setState(initial, true)
})

describe('SubagentChip', () => {
  it('renders nothing for a session without subagents', () => {
    const { container } = render(<SubagentChip sessionId={SESSION_ID} subagents={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('opens the list, and picking a row opens that agent and closes the list; a row without a transcript does nothing', () => {
    const openSubagent = vi.fn(async () => {})
    useOrbital.setState({ openSubagent })
    const running = agent('a')
    const orphan = agent('b', { state: 'ended', status: 'completed', endedAt: 5, toolUseId: undefined })
    render(<SubagentChip sessionId={SESSION_ID} subagents={[running, orphan]} />)

    fireEvent.click(screen.getByTitle('Subagents in this session'))
    const orphanRow = screen.getByRole('menuitem', { name: 'Task b' })
    expect(orphanRow).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(orphanRow)
    expect(openSubagent).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Task a' }))
    expect(openSubagent).toHaveBeenCalledWith(SESSION_ID, running)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
