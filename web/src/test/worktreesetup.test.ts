import { describe, expect, it } from 'vitest'
import type { SessionSetup, SetupPhase } from '@orbital/shared/worktree'
import { sessionStateKey, setupPending, statePill, type ApiSession, type SessionStatus } from '../lib/types'
import {
  discardSentence,
  setupAttachments,
  setupBlock,
  setupPromptText,
  withoutWorktreePrefill,
} from '../lib/setup'
import { menuFor } from '../lib/sessionMenu'
import { contextMenuGroups } from '../lib/sessionContextMenu'
import { readoutSegments } from '../map/readout'
import { planetStateOf } from '../map/visuals'
import { PLANET_TICK_LAYERS } from '../map/transition'
import { groupOf, groupSessions } from '../mobile/sessionList'
import { composerPlaceholder } from '../mobile/composer'
import { withSetupTurns } from '../store/store'
import type { ChatMessage } from '../lib/types'

function setup(patch: Partial<SessionSetup> = {}): SessionSetup {
  return {
    phase: 'checkout',
    step: 2,
    branch: 'feat/tray-preview',
    path: '/w/repo/.claude/worktrees/tray-preview',
    readyInMs: null,
    message: null,
    errorId: null,
    prompt: 'Show a preview of the session.',
    attachments: [],
    queued: [],
    launch: { cwd: '/w/repo', base: 'main', permissionMode: 'acceptEdits' },
    ...patch,
  }
}

function session(id: string, patch: Partial<ApiSession> = {}): ApiSession {
  return {
    id, cwd: '/w/repo', title: id, firstAt: 1, lastAt: 1, messageCount: 0, source: 'web', permissionMode: null,
    model: null, resolvedModel: null, tagIds: [], status: 'idle', subagents: [], ...patch,
  }
}

const inPhase = (phase: SetupPhase, patch: Partial<ApiSession> = {}) => session(phase, { setup: setup({ phase }), ...patch })

describe('a worktree launch’s state', () => {
  it('reads SETTING UP through the three steps and NOT STARTED once failed, whatever the idle status says', () => {
    for (const phase of ['naming', 'checkout', 'copy'] as const) {
      expect(sessionStateKey(inPhase(phase))).toBe('setting_up')
      expect(setupPending(inPhase(phase))).toBe(true)
    }
    expect(sessionStateKey(inPhase('failed'))).toBe('not_started')
    expect(setupPending(inPhase('failed'))).toBe(true)
  })

  it('takes the session’s own state once ready, and is unchanged without a setup', () => {
    expect(sessionStateKey(inPhase('ready', { status: 'working' }))).toBe('working')
    expect(setupPending(inPhase('ready'))).toBe(false)
    expect(sessionStateKey(session('plain'))).toBe('idle')
  })

  it('wears a pill on the map only when it did not start, and a neutral one', () => {
    expect(statePill(inPhase('checkout'))).toBeNull()
    expect(statePill(inPhase('failed'))).toEqual({ key: 'not_started', label: 'NOT STARTED' })
  })

  it('draws its planet in its setup state, and with no tick ring while being born', () => {
    expect(planetStateOf(inPhase('naming'))).toBe('setting_up')
    expect(planetStateOf(inPhase('failed'))).toBe('not_started')
    expect(planetStateOf(inPhase('ready', { status: 'working' }))).toBe('working')
    expect(PLANET_TICK_LAYERS.some((layer) => layer.states.includes('setting_up'))).toBe(false)
  })
})

describe('the map’s readout', () => {
  const counts = (patch: Partial<Record<SessionStatus, number>> = {}) => ({ working: 0, idle: 0, needs_input: 0, ended: 0, ...patch })

  it('counts SETTING UP after WORKING and NOT STARTED after INTERRUPTED, only when there are any', () => {
    const planets = [inPhase('naming'), inPhase('copy'), inPhase('failed')].map((s) => ({ session: s }))
    expect(readoutSegments(counts({ working: 1, idle: 2 }), planets).map((s) => s.text)).toEqual([
      '1 WORKING',
      '2 SETTING UP',
      '1 NOT STARTED',
      '2 IDLE',
      '0 ENDED',
    ])
    expect(readoutSegments(counts(), []).map((s) => s.key)).toEqual(['working', 'idle', 'ended'])
  })

  it('leaves out a muted planet or one of a device switched off', () => {
    const planets = [
      { session: inPhase('naming'), muted: true },
      { session: inPhase('failed'), deviceOff: true },
    ]
    expect(readoutSegments(counts(), planets).map((s) => s.key)).toEqual(['working', 'idle', 'ended'])
  })
})

describe('the phone’s list', () => {
  it('groups a launch being set up after WORKING and a failed one after the limit wait, above IDLE', () => {
    expect(groupOf(inPhase('naming'))).toBe('setting_up')
    expect(groupOf(inPhase('failed'))).toBe('not_started')
    const groups = groupSessions(
      [
        session('idle'),
        inPhase('failed'),
        inPhase('checkout'),
        session('working', { status: 'working' }),
        session('limit', { limitWait: { resetsAt: 1, windowLabel: '5-hour', queued: [], auto: true, cancelled: false } as never }),
      ],
      [],
    )
    expect(groups.map((g) => g.key)).toEqual(['working', 'setting_up', 'limit', 'not_started', 'idle'])
  })
})

describe('what a launch not started offers', () => {
  it('while setting up: its labels at once, Copy first prompt, and Discard as the one deliberate row', () => {
    expect(menuFor(inPhase('checkout'), false).items).toEqual(['rename', 'tag', 'pin', 'copy-prompt', 'discard'])
  })

  it('once failed: the ways out first, never Clear or End', () => {
    expect(menuFor(inPhase('failed'), false).items).toEqual([
      'retry',
      'without-worktree',
      'copy-prompt',
      'error-log',
      'pin',
      'discard',
    ])
  })

  it('gives the desktop menu the same set, Discard in the deliberate group and no name to regenerate', () => {
    const actions = (s: ApiSession) =>
      contextMenuGroups(s, { offline: false, detachable: false }).map((group) => group.map((row) => row.action))
    expect(actions(inPhase('naming'))).toEqual([['open'], ['rename', 'tag', 'pin', 'copy-prompt', 'copy-path'], ['discard']])
    expect(actions(inPhase('failed'))).toEqual([
      ['open'],
      ['retry', 'without-worktree', 'copy-prompt', 'error-log', 'pin', 'copy-path'],
      ['discard'],
    ])
    // Started, the menu is the ordinary one again.
    expect(actions(inPhase('ready', { status: 'working' })).at(-1)).toEqual(['clear', 'end'])
  })
})

describe('the words of a launch not started', () => {
  const queued = [{ text: 'Also show how long ago.' }, { text: '  ' }, { text: 'And the model.', attachments: ['b', 'a'] }]

  it('copies the prompt and the queue as one text, a blank line between each, skipping empty ones', () => {
    expect(setupPromptText(setup({ queued }))).toBe('Show a preview of the session.\n\nAlso show how long ago.\n\nAnd the model.')
    expect(setupPromptText(setup({ prompt: '', queued: [{ text: 'Only this.' }] }))).toBe('Only this.')
  })

  it('carries every attachment once, the prompt’s first', () => {
    expect(setupAttachments(setup({ attachments: ['a', 'c'], queued }))).toEqual(['a', 'c', 'b'])
  })

  it('says in the discard dialog what stops and what goes with it', () => {
    expect(discardSentence(setup())).toBe('Setup stops and nothing is left on disk. The first prompt goes with it.')
    expect(discardSentence(setup({ phase: 'failed', queued: [{ text: 'x' }] }))).toBe(
      'Nothing was set up and nothing is on disk. The first prompt and 1 queued message go with it.',
    )
    expect(discardSentence(setup({ queued: [{ text: 'x' }, { text: 'y' }] }))).toContain('2 queued messages go with it.')
  })

  it('keeps the block to its steps: the one running, the ones done, the ones ahead', () => {
    expect(setupBlock(setup({ phase: 'naming', branch: null })).lines.map((l) => l.tone)).toEqual(['now', 'pending', 'pending'])
    expect(setupBlock(setup({ phase: 'copy' })).lines.map((l) => l.tone)).toEqual(['done', 'done', 'now'])
    expect(setupBlock(setup({ phase: 'ready', readyInMs: 14_200 })).right).toBe('ready in 14 s')
    const failed = setupBlock(setup({ phase: 'failed', message: 'The disk is full.', queued: [{ text: 'x' }] }))
    expect(failed.failed).toBe(true)
    expect(failed.lines.map((l) => l.text)).toEqual([
      'The disk is full.',
      'Nothing was left on disk. Your prompt and 1 queued message are kept.',
    ])
  })

  it('opens New Session with the launch’s settings and the whole text, to replace this session', () => {
    const s = session('s1', {
      title: 'Tray preview',
      machine: { id: 'm2', name: 'Studio' } as ApiSession['machine'],
      setup: setup({
        phase: 'failed',
        queued,
        attachments: ['a'],
        launch: { cwd: '/w/repo/web', base: 'main', permissionMode: 'plan', model: 'opus', tagId: 3, claudeDirId: 2 },
      }),
    })
    expect(withoutWorktreePrefill(s, s.setup!)).toEqual({
      replaces: 's1',
      title: 'Tray preview',
      device: 'm2',
      cwd: '/w/repo/web',
      permissionMode: 'plan',
      model: 'opus',
      tagId: 3,
      claudeDirId: 2,
      prompt: 'Show a preview of the session.\n\nAlso show how long ago.\n\nAnd the model.',
      attachments: ['a', 'b'],
    })
  })

  it('tells the phone’s composer that what it writes is queued', () => {
    const base = { pending: undefined, target: null, ended: false }
    expect(composerPlaceholder({ ...base, setup: { phase: 'checkout' } }).text).toBe('Queue a message for when it starts…')
    expect(composerPlaceholder({ ...base, setup: { phase: 'failed' } }).text).toBe('Queue a message…')
    expect(composerPlaceholder({ ...base, setup: { phase: 'ready' } }).text).toBe('Reply to Claude…')
  })
})

describe('a launch that just started', () => {
  const turn = (id: string, text: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({ id, role, text, timestamp: '' })

  it('puts the prompt and the queue in as sent turns, ahead of the first reply', () => {
    const held = [turn('r1', 'Looking at the tray.', 'assistant')]
    const out = withSetupTurns(held, setup({ queued: [{ text: 'Also the time.' }] }))
    expect(out.map((m) => m.text)).toEqual(['Show a preview of the session.', 'Also the time.', 'Looking at the tray.'])
    expect(out.slice(0, 2).every((m) => m.id.startsWith('local:'))).toBe(true)
  })

  it('does not repeat the launch’s own turn this tab already holds', () => {
    const held = [turn('local:1', 'Show a preview of the session.')]
    expect(withSetupTurns(held, setup()).map((m) => m.id)).toEqual(['local:1'])
  })
})
