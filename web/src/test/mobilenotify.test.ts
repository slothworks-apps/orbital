import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NOTIFICATION_SETTINGS, type SessionNotification } from '@orbital/shared/notifications'
import type { ApiSession, PendingDecision } from '../lib/types'
import { BANNER_MS } from '../mobile/constants'
import {
  BANNER_LINE_MAX, bannerLine, channelFor, decideNotification, notificationId, seedNotifications, setRules, useBanner, wireNotifications,
} from '../mobile/notify'
import { initialMobileState, useMobile } from '../mobile/state'
import { clientRef } from '../mobile/transport/clientRef'
import { useOrbital } from '../store/store'
import { FakeClient } from './fakeRemoteClient'

const RULES = DEFAULT_NOTIFICATION_SETTINGS
const ASKS: SessionNotification = { title: 'orbital', body: 'Needs your input', sessionId: 's1' }

describe('decideNotification', () => {
  it('shows only the banner in the foreground, on another screen, with the background rule on', () => {
    expect(decideNotification(ASKS, { active: true, viewing: 's2', rules: RULES })).toEqual({ banner: true, system: false })
    expect(decideNotification(ASKS, { active: true, viewing: null, rules: RULES })).toEqual({ banner: true, system: false })
  })

  it('shows nothing for the session on screen while the rule holds back the system one', () => {
    expect(decideNotification(ASKS, { active: true, viewing: 's1', rules: RULES })).toEqual({ banner: false, system: false })
  })

  it('posts the system notification next to the banner in the foreground when the rule is off', () => {
    const rules = { ...RULES, onlyWhenBackground: false }
    expect(decideNotification(ASKS, { active: true, viewing: 's2', rules })).toEqual({ banner: true, system: true })
  })

  it('posts only the system notification in the background, whatever was on screen', () => {
    expect(decideNotification(ASKS, { active: false, viewing: 's1', rules: RULES })).toEqual({ banner: false, system: true })
  })

  it('banners a failure that names no session even when no session is on screen', () => {
    const failed = { title: 'Session', body: 'Session failed: boom', sessionId: null }
    expect(decideNotification(failed, { active: true, viewing: null, rules: RULES }).banner).toBe(true)
  })
})

describe('channelFor', () => {
  it('picks the sounding channel only when the sound rule is on', () => {
    expect(channelFor({ ...RULES, sound: true })).toBe('needs_input_sound')
    expect(channelFor({ ...RULES, sound: false })).toBe('needs_input')
  })
})

describe('notificationId', () => {
  it('is stable, positive, fits 31 bits and tells two sessions apart', () => {
    const a = notificationId('3f1c2b9e-0000-4000-8000-000000000001')
    expect(notificationId('3f1c2b9e-0000-4000-8000-000000000001')).toBe(a)
    expect(Number.isInteger(a)).toBe(true)
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThanOrEqual(0x7fffffff)
    expect(notificationId('3f1c2b9e-0000-4000-8000-000000000002')).not.toBe(a)
  })

  it('gives every sessionless failure the same id', () => {
    expect(notificationId(null)).toBe(notificationId(null))
    expect(notificationId(null)).toBeGreaterThan(0)
  })
})

describe('useBanner', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    useBanner.getState().dismiss()
    vi.useRealTimers()
  })

  const one = { sessionId: 's1', title: 'orbital', needsInput: true, line: 'PERMISSION · ls' }
  const two = { sessionId: 's2', title: 'docs', needsInput: true, line: 'Needs your input' }

  it('shows a banner and hides it on its own after BANNER_MS', () => {
    useBanner.getState().show(one)
    expect(useBanner.getState().current).toMatchObject(one)
    vi.advanceTimersByTime(BANNER_MS - 1)
    expect(useBanner.getState().current).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(useBanner.getState().current).toBeNull()
  })

  it('replaces the banner with a newer one and restarts the timer', () => {
    useBanner.getState().show(one)
    vi.advanceTimersByTime(BANNER_MS - 1)
    useBanner.getState().show(two)
    expect(useBanner.getState().current).toMatchObject(two)
    vi.advanceTimersByTime(BANNER_MS - 1)
    expect(useBanner.getState().current).toMatchObject(two)
    vi.advanceTimersByTime(1)
    expect(useBanner.getState().current).toBeNull()
  })

  it('dismisses at once, and a stale timer does not hide the next banner early', () => {
    useBanner.getState().show(one)
    vi.advanceTimersByTime(BANNER_MS / 2)
    useBanner.getState().dismiss()
    expect(useBanner.getState().current).toBeNull()
    useBanner.getState().show(two)
    vi.advanceTimersByTime(BANNER_MS / 2)
    expect(useBanner.getState().current).toMatchObject(two)
  })
})

describe('bannerLine', () => {
  const verdict = (over: Partial<PendingDecision>): PendingDecision =>
    ({ id: 't1', kind: 'permission', input: {}, createdAt: 0, toolName: 'Bash', ...over }) as PendingDecision

  it('names a permission by its chip and the input summary', () => {
    expect(bannerLine(ASKS, verdict({ input: { command: 'npm test' } }))).toBe('PERMISSION · npm test')
  })

  it('falls back to the headline when the input has no summary', () => {
    expect(bannerLine(ASKS, verdict({ kind: 'plan', input: { plan: '# Plan' } }))).toBe(
      'PLAN · Claude has a plan and wants to start on it',
    )
  })

  it('keeps a long or multi-line ask to one capped line', () => {
    const line = bannerLine(ASKS, verdict({ input: { command: `echo one\n${'x'.repeat(200)}` } }))
    expect(line).not.toContain('\n')
    expect(line.length).toBe(BANNER_LINE_MAX)
    expect(line.endsWith('…')).toBe(true)
  })

  it('names a question by its first header', () => {
    const question = {
      id: 'q1', kind: 'question', createdAt: 0,
      input: { questions: [{ question: 'Which?', header: 'Database', options: [], multiSelect: false }] },
    } as PendingDecision
    expect(bannerLine(ASKS, question)).toBe('Question · Database')
  })

  it("says the notifier's body when nothing is pending", () => {
    expect(bannerLine(ASKS, undefined)).toBe('Needs your input')
  })
})

describe('wireNotifications', () => {
  const upsert = (status: string, pendingDecision: PendingDecision | null = null) => ({
    topic: 'sessions', event: 'upsert', session: { id: 's1', title: 'orbital', cwd: '/x/orbital', status, pendingDecision },
  })
  const ask = {
    id: 't1', kind: 'permission', input: { command: 'npm test' }, createdAt: 0, toolName: 'Bash',
  } as PendingDecision

  const status = (to: string) => ({ topic: 'sessions', event: 'status', sessionId: 's1', status: to })
  const row = (patch: Partial<ApiSession> = {}): ApiSession => ({
    id: 's1', cwd: '/x/orbital', title: 'orbital', firstAt: 1, lastAt: 1, messageCount: 1, source: 'web',
    permissionMode: null, model: null, resolvedModel: null, tagIds: [], status: 'working', subagents: [], ...patch,
  })
  // The banner is reported a microtask after the frame.
  const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve))

  let client: FakeClient
  /** A new tunnel: the notifier is renewed and seeded from what the store holds now. */
  const open = () => client.emit({ type: 'ready', ready: true })
  beforeEach(() => {
    // Every event on: these tests are about what a notification says, not whether one is due.
    setRules({ needsInput: true, sessionEnded: true, sessionFailed: true, onlyWhenBackground: true, sound: true })
    wireNotifications()
    client = new FakeClient()
    clientRef.set(client)
    useMobile.setState({ screen: 'list', sessionId: null })
  })
  afterEach(() => {
    clientRef.set(null)
    useBanner.getState().dismiss()
    useOrbital.setState({ pendingDecisions: {}, sessions: {} })
    useMobile.setState({ ...initialMobileState })
  })

  it('names the ask the upsert carries before the store has applied it', async () => {
    open()
    expect(useOrbital.getState().pendingDecisions.s1).toBeUndefined()
    client.emit({ type: 'hub', frame: upsert('working') })
    client.emit({ type: 'hub', frame: upsert('needs_input', ask) })
    await settled()
    expect(useBanner.getState().current).toMatchObject({
      sessionId: 's1', title: 'orbital', needsInput: true, line: 'PERMISSION · npm test',
    })
  })

  it('names the ask an earlier upsert carried when the status frame moves the session (the Mac\'s order)', async () => {
    open()
    client.emit({ type: 'hub', frame: upsert('working') })
    client.emit({ type: 'hub', frame: upsert('working', ask) })
    client.emit({ type: 'hub', frame: status('needs_input') })
    await settled()
    expect(useBanner.getState().current?.line).toBe('PERMISSION · npm test')
  })

  it("falls back to the store's decision for a frame that carries none", async () => {
    open()
    useOrbital.setState({ pendingDecisions: { s1: ask } })
    client.emit({ type: 'hub', frame: upsert('working') })
    client.emit({ type: 'hub', frame: status('needs_input') })
    await settled()
    expect(useBanner.getState().current?.line).toBe('PERMISSION · npm test')
  })

  it("reads the decision off the store's session row on a status frame", async () => {
    useOrbital.setState({ sessions: { s1: row({ pendingDecision: ask }) } })
    open()
    client.emit({ type: 'hub', frame: status('needs_input') })
    await settled()
    expect(useBanner.getState().current?.line).toBe('PERMISSION · npm test')
  })

  it("seeds a new tunnel's notifier from the store, so the first transition is reported", async () => {
    useOrbital.setState({ sessions: { s1: row() } })
    open()
    client.emit({ type: 'hub', frame: status('needs_input') })
    await settled()
    expect(useBanner.getState().current).toMatchObject({ sessionId: 's1', title: 'orbital', needsInput: true })
  })

  it("seeds from the Mac's list once resync has read it", async () => {
    open()
    seedNotifications([row()])
    client.emit({ type: 'hub', frame: status('needs_input') })
    await settled()
    expect(useBanner.getState().current?.sessionId).toBe('s1')
  })

  it('reports a question about an unseeded session — a status frame is never a replay', async () => {
    open()
    client.emit({ type: 'hub', frame: status('needs_input') })
    await settled()
    expect(useBanner.getState().current).toMatchObject({ sessionId: 's1', needsInput: true })
  })

  it('reports nothing for an unseeded session whose first upsert is old news', async () => {
    open()
    client.emit({ type: 'hub', frame: upsert('needs_input') })
    await settled()
    expect(useBanner.getState().current).toBeNull()
  })

  it('a seed never overrides what the hub said since the tunnel opened', async () => {
    open()
    client.emit({ type: 'hub', frame: upsert('needs_input') })
    // A list read before the frame went out, landing after it.
    seedNotifications([row({ status: 'working' })])
    client.emit({ type: 'hub', frame: status('needs_input') })
    await settled()
    expect(useBanner.getState().current).toBeNull()
  })

  it('shows no banner over the pairing, unpaired or mismatch screens', async () => {
    for (const screen of ['pairing', 'unpaired', 'mismatch'] as const) {
      useMobile.setState({ screen })
      useOrbital.setState({ sessions: { s1: row() } })
      open()
      client.emit({ type: 'hub', frame: status('needs_input') })
      await settled()
      expect(useBanner.getState().current).toBeNull()
    }
  })
})
