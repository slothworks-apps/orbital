import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ApiSession, ChatMessage, Subagent } from '../lib/types'
import { useOrbital } from '../store/store'
import {
  COMPACTING_LABEL_DELAY_MS,
  compactConfirmCount,
  compactingLabelOpacity,
  compactingOf,
  compactionOrdinals,
  formatElapsed,
  newestFailedCompactionId,
} from '../lib/compaction'
import { useCompactionUi } from '../store/compaction'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { DetailPanel } from '../panels/DetailPanel'

/**
 * Context compaction on the web side (spec
 * 2026-09-28-context-compaction-design § Testing): the planet's state
 * derivation, the three-second rule, the confirm predicate, `N OF M`, and the
 * composer lock.
 */

function session(overrides: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's1',
    cwd: '/w',
    title: 'Session',
    firstAt: 1,
    lastAt: 2,
    messageCount: 1,
    source: 'web',
    permissionMode: 'acceptEdits',
    model: null,
    resolvedModel: null,
    tagIds: [],
    status: 'working',
    subagents: [],
    ...overrides,
  }
}

const agent = (state: Subagent['state'], id = 'a1'): Subagent => ({ id, name: 'agent', state, startedAt: 0 })
const compacting = { startedAt: 1_000, trigger: 'auto' as const }

describe('compactingOf — the planet state', () => {
  it('outranks working and waiting for an agent', () => {
    expect(compactingOf(session({ compacting }))).toEqual(compacting)
    expect(
      compactingOf(session({ compacting, awaitingSubagents: true, subagents: [agent('working')] })),
    ).toEqual(compacting)
  })

  it('loses to needs-input', () => {
    const asking = session({
      compacting,
      status: 'needs_input',
      pendingDecision: { id: 'd', kind: 'question', input: { questions: [] }, createdAt: 0 },
    })
    expect(compactingOf(asking)).toBeNull()
  })

  it('is never shown for a terminal session, an ended one, or one not compacting', () => {
    expect(compactingOf(session({ compacting, source: 'terminal' }))).toBeNull()
    expect(compactingOf(session({ compacting, status: 'ended' }))).toBeNull()
    expect(compactingOf(session({ compacting: null }))).toBeNull()
  })
})

describe('the three-second rule', () => {
  it('shows no label before three seconds, then fades it in', () => {
    expect(compactingLabelOpacity(0)).toBe(0)
    expect(compactingLabelOpacity(COMPACTING_LABEL_DELAY_MS - 1)).toBe(0)
    expect(compactingLabelOpacity(COMPACTING_LABEL_DELAY_MS + 100)).toBeGreaterThan(0)
    expect(compactingLabelOpacity(COMPACTING_LABEL_DELAY_MS + 10_000)).toBe(1)
  })

  it('counts past a minute as m:ss', () => {
    expect(formatElapsed(14_000)).toBe('0:14')
    expect(formatElapsed(156_400)).toBe('2:36')
  })
})

describe('compactConfirmCount — does this send need confirming', () => {
  const running = session({ subagents: [agent('working', 'a'), agent('idle', 'b'), agent('ended', 'c')] })

  it('confirms a /compact, with or without arguments, while subagents run', () => {
    expect(compactConfirmCount('/compact', running)).toBe(2)
    expect(compactConfirmCount('  /compact keep the plan ', running)).toBe(2)
  })

  it('lets everything else through', () => {
    expect(compactConfirmCount('/compact', session({ subagents: [agent('ended')] }))).toBe(0)
    expect(compactConfirmCount('please compact', running)).toBe(0)
    expect(compactConfirmCount('/compactify', running)).toBe(0)
    expect(compactConfirmCount('/compact', undefined)).toBe(0)
  })
})

describe('compactionOrdinals — N OF M', () => {
  const mark = (id: string, outcome: 'success' | 'failed'): ChatMessage => ({
    id,
    role: 'compaction',
    compaction: { outcome, trigger: 'auto', preTokens: 1, postTokens: null, durationMs: null },
  })

  it('numbers the successful compactions only, and knows the newest failure', () => {
    const messages = [
      mark('c1', 'success'),
      { id: 'm', role: 'assistant', text: 'x' } as ChatMessage,
      mark('f1', 'failed'),
      mark('c2', 'success'),
      mark('f2', 'failed'),
    ]
    const ordinals = compactionOrdinals(messages)
    expect(ordinals.get('c1')).toEqual({ n: 1, of: 2 })
    expect(ordinals.get('c2')).toEqual({ n: 2, of: 2 })
    expect(ordinals.has('f1')).toBe(false)
    expect(newestFailedCompactionId(messages)).toBe('f2')
  })
})

describe('the composer while a compaction runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.walkthroughSummary).mockReturnValue(new Promise(() => {}))
    useCompactionUi.setState({ confirm: null, reveal: null })
  })

  function renderWith(s: ApiSession, draft = '') {
    useOrbital.setState((state) => ({
      sessions: { [s.id]: s },
      order: [s.id],
      transcripts: {},
      composerDrafts: draft ? { [s.id]: draft } : {},
      ui: { ...state.ui, selectedId: s.id, dialog: null },
    }))
    return render(<DetailPanel />)
  }

  it('is locked, says why, and cannot send', () => {
    renderWith(session({ compacting: { startedAt: Date.now(), trigger: 'manual' } }), 'hello')
    const field = screen.getByRole('textbox', { name: 'Prompt' })
    expect(field).toBeDisabled()
    expect(field).toHaveAttribute('placeholder', 'Compacting. You can write again when it’s done.')
    expect(screen.getByRole('button', { name: /Send/ })).toBeDisabled()
  })

  it('is open again once it is not compacting', () => {
    renderWith(session({ compacting: null }), 'hello')
    expect(screen.getByRole('textbox', { name: 'Prompt' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /Send/ })).not.toBeDisabled()
  })

  it('asks before a /compact runs past subagents, and keeps the draft', async () => {
    renderWith(session({ status: 'needs_input', subagents: [agent('working')] }), '/compact')
    await userEvent.click(screen.getByRole('button', { name: /Send/ }))
    expect(useCompactionUi.getState().confirm).toEqual({ sessionId: 's1', text: '/compact', count: 1 })
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(useOrbital.getState().composerDrafts.s1).toBe('/compact')
  })
})
