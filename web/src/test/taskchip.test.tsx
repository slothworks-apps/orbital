import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BackgroundTask } from '../lib/types'
import { useOrbital } from '../store/store'
import { TaskChip } from '../panels/TaskChip'

// A store action reached by accident resolves instead of throwing.
vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

// ---------------------------------------------------------------------------
// The ▣ chip (spec 2026-09-28-background-tasks-design § 3): what it wires —
// counts, groups and words are `lib/backgroundTasks`'s and tested there.
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-1'

function task(id: string, overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return { id, kind: 'shell', label: `Task ${id}`, command: 'npm run dev', state: 'running', startedAt: 0, hasOutput: true, ...overrides }
}

const initial = useOrbital.getState()
afterEach(() => {
  cleanup()
  useOrbital.setState(initial, true)
})

describe('TaskChip', () => {
  it('stops a running task from its ■ without opening the row', () => {
    const stopTask = vi.fn(async () => {})
    const openTaskOutput = vi.fn(async () => {})
    useOrbital.setState({ stopTask, openTaskOutput })
    render(<TaskChip sessionId={SESSION_ID} tasks={[task('b1')]} />)

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop Task b1' }))
    expect(stopTask).toHaveBeenCalledWith(SESSION_ID, 'b1')
    expect(openTaskOutput).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Task b1' }))
    expect(openTaskOutput).toHaveBeenCalledWith(SESSION_ID, 'b1')
  })

  it('does not open a workflow, which has no output', () => {
    const openTaskOutput = vi.fn(async () => {})
    useOrbital.setState({ openTaskOutput })
    render(<TaskChip sessionId={SESSION_ID} tasks={[task('w1', { kind: 'workflow', command: undefined, hasOutput: false })]} />)

    fireEvent.click(screen.getByRole('button', { expanded: false }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Task w1' }))
    expect(openTaskOutput).not.toHaveBeenCalled()
  })
})
