import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import type { BackgroundTask, ChatMessage, Subagent } from '../lib/types'
import { PhoneToolRowContext, ToolRow, type ToolRowChipTarget } from '../panels/ToolRow'

// The phone's seam into the shared tool row (spec 2026-10-05-mobile-next § 3,
// canvas 10g): without it the desktop's row must stay as it was.

const agentCall: ChatMessage = { id: 'u1', role: 'tool_use', toolName: 'Agent', toolUseId: 'tu-a', toolInput: { description: 'tests' } }
const bashCall: ChatMessage = { id: 'u2', role: 'tool_use', toolName: 'Bash', toolUseId: 'tu-b', toolInput: { command: 'npm run dev' } }
const agent: Subagent = { id: 's1', name: 'tests', state: 'working', startedAt: 0, toolUseId: 'tu-a' }
// Ended without an output file: the desktop has nothing to open, the phone's chip still tells how it ended.
const task: BackgroundTask = {
  id: 't1', kind: 'shell', label: 'npm run dev', state: 'ended', status: 'failed', exitCode: 1,
  startedAt: 0, endedAt: 1, toolUseId: 'tu-b', hasOutput: false,
}

function rows(phone: { renderChip: (t: ToolRowChipTarget) => null } | null) {
  return render(
    <PhoneToolRowContext.Provider value={phone}>
      <ToolRow toolUse={agentCall} subagents={[agent]} onOpenSubagent={vi.fn()} />
      <ToolRow toolUse={bashCall} backgroundTasks={[task]} onOpenTaskOutput={vi.fn()} />
    </PhoneToolRowContext.Provider>,
  )
}

describe('the tool row without the phone seam (the desktop)', () => {
  it('keeps the inline OPEN → and draws no chip', () => {
    rows(null)
    expect(screen.getByRole('button', { name: 'Open subagent transcript: tests' })).toBeTruthy()
    // No output file, so no OUTPUT → either — as before.
    expect(document.querySelector('[data-open-task-output]')).toBeNull()
  })
})

describe('the tool row with the phone seam', () => {
  it('hands each launching row to the chip and drops the inline controls', () => {
    const renderChip = vi.fn((_target: ToolRowChipTarget) => null)
    rows({ renderChip })
    expect(renderChip.mock.calls.map(([t]) => t)).toEqual([
      { kind: 'subagent', subagent: agent },
      { kind: 'task', task },
    ])
    expect(document.querySelector('[data-open-subagent]')).toBeNull()
  })
})
