import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventLine, generateStepId, harnessProgress } from '../lib/harness'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { DEFAULT_HARNESS_OPTIONS, type SessionHarness } from '../lib/types'
import { rewindCountFor } from '../lib/harness'

describe('generateStepId', () => {
  it('folds diacritics and keeps ids unique', () => {
    expect(generateStepId('Načíst design, ticket a legacy')).toBe('nacist-design-ticket-a-legacy')
    expect(generateStepId('  Parita — design vs Storybook ')).toBe('parita-design-vs-storybook')
    expect(generateStepId('!!!')).toBe('step')
    expect(generateStepId('Step 1', ['step-1'])).toBe('step-1-2')
    expect(generateStepId('Step 1', ['step-1', 'step-1-2'])).toBe('step-1-3')
  })
})

describe('harnessProgress', () => {
  it('counts done steps and notices a waiting gate', () => {
    expect(harnessProgress([{ status: 'done' }, { status: 'awaiting_approval' }, { status: 'pending' }]))
      .toEqual({ done: 1, total: 3, awaiting: true })
    expect(harnessProgress([{ status: 'done' }, { status: 'active' }])).toEqual({ done: 1, total: 2, awaiting: false })
  })
})

describe('eventLine', () => {
  it('names the step by title and carries the reason', () => {
    const steps = [{ id: 'api', title: 'Tune the API', instructions: '', mode: 'gate' as const, doneWhen: '' }]
    expect(eventLine({ id: 1, sessionId: 's', at: 0, kind: 'watcher_stop', detail: { step: 'api', reason: 'needs a colour' } }, steps))
      .toBe('stopped for you “Tune the API” — needs a colour')
    expect(eventLine({ id: 2, sessionId: 's', at: 0, kind: 'ticked', detail: { step: 'gone' } }, steps)).toBe('ticked “gone”')
  })
})

describe('the harness slot', () => {
  const harness: SessionHarness = {
    sessionId: 's1', templateId: 1, name: 'H', steps: [], inputs: {}, state: [], options: DEFAULT_HARNESS_OPTIONS, paused: false,
    pauseReason: null, pauseKind: null, pausedAt: null, removedAt: null, autoRounds: 0, idleNudges: 0, createdAt: 0, updatedAt: 0,
  }

  beforeEach(() => {
    vi.spyOn(api, 'getSessionHarness').mockResolvedValue({ harness, removed: null, events: [], proposal: null })
    useOrbital.setState({ harnesses: {}, harnessEvents: {}, harnessPanel: null, subagentPanel: null, taskOutput: null })
    useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 's1' } }))
  })

  it('a `harness` event updates the session, and a removal reads as none', () => {
    useOrbital.getState().applySessionEvent('s1', { event: 'harness', harness })
    expect(useOrbital.getState().harnesses.s1).toEqual(harness)
    useOrbital.getState().applySessionEvent('s1', { event: 'harness', harness: null })
    expect(useOrbital.getState().harnesses.s1).toBeNull()
  })

  it('opening it loads the harness; selecting another session closes it', async () => {
    useOrbital.getState().openHarness('s1')
    expect(useOrbital.getState().harnessPanel).toEqual({ sessionId: 's1' })
    await vi.waitFor(() => expect(useOrbital.getState().harnesses.s1).toEqual(harness))
    useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 's2' } }))
    expect(useOrbital.getState().harnessPanel).toBeNull()
  })
})

describe('rewindCountFor', () => {
  it('counts the conversation rows from the step\'s message on', () => {
    const messages = [
      { uuid: 'a', role: 'user' }, { role: 'assistant' }, { uuid: 'b', role: 'user' }, { role: 'tool_use' }, { role: 'assistant' },
    ]
    expect(rewindCountFor(messages, 'b')).toBe(2)
    expect(rewindCountFor(messages, 'a')).toBe(4)
    expect(rewindCountFor(messages, 'zzz')).toBeNull()
  })
})
