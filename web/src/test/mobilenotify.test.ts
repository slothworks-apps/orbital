import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NOTIFICATION_SETTINGS, NEEDS_INPUT_SETTLE_MS, type SessionNotification } from '@orbital/shared/notifications'
import type { ApiSession, PendingDecision } from '../lib/types'
import { BANNER_MS } from '../mobile/constants'
import {
  BANNER_LINE_MAX, bannerLine, channelFor, decideNotification, notificationId, seedNotifications, setActive, setRules, useBanner,
  wireNotifications,
} from '../mobile/notify'
import { postLocalNotification, removeDeliveredNotification } from '../mobile/platform/localNotify'
import { initialMobileState, useMobile } from '../mobile/state'
import { clientRef } from '../mobile/transport/clientRef'
import { useOrbital } from '../store/store'
import { FakeClient } from './fakeRemoteClient'

vi.mock('../mobile/platform/localNotify', () => ({
  postLocalNotification: vi.fn(async () => {}),
  removeDeliveredNotification: vi.fn(async () => {}),
}))

const RULES = DEFAULT_NOTIFICATION_SETTINGS
const ASKS: SessionNotification = { kind: 'needs_input', title: 'orbital', body: 'Needs your input', sessionId: 's1' }

describe('decideNotification', () => {
  it('shows only the banner in the foreground, on another screen, with the background rule on', () => {
    expect(decideNotification(ASKS, { active: true, viewing: 's2', rules: RULES, atMac: false })).toEqual({ banner: true, system: false })
    expect(decideNotification(ASKS, { active: true, viewing: null, rules: RULES, atMac: false })).toEqual({ banner: true, system: false })
  })

  it('shows nothing for the session on screen while the rule holds back the system one', () => {
    expect(decideNotification(ASKS, { active: true, viewing: 's1', rules: RULES, atMac: false })).toEqual({ banner: false, system: false })
  })

  it('posts the system notification next to the banner in the foreground when the rule is off', () => {
    const rules = { ...RULES, onlyWhenBackground: false }
    expect(decideNotification(ASKS, { active: true, viewing: 's2', rules, atMac: false })).toEqual({ banner: true, system: true })
  })

  it('posts only the system notification in the background, whatever was on screen', () => {
    expect(decideNotification(ASKS, { active: false, viewing: 's1', rules: RULES, atMac: false })).toEqual({ banner: false, system: true })
  })

  it('posts nothing to the system while the user is at the Mac, and still banners in the foreground', () => {
    expect(decideNotification(ASKS, { active: false, viewing: null, rules: RULES, atMac: true })).toEqual({ banner: false, system: false })
    const rules = { ...RULES, onlyWhenBackground: false }
    expect(decideNotification(ASKS, { active: true, viewing: 's2', rules, atMac: true })).toEqual({ banner: true, system: false })
  })

  it('banners a failure that names no session even when no session is on screen', () => {
    const failed: SessionNotification = { kind: 'failed', title: 'Session', body: 'Session failed: boom', sessionId: null }
    expect(decideNotification(failed, { active: true, viewing: null, rules: RULES, atMac: false }).banner).toBe(true)
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

  it('says Done for a finished turn, whatever decision the store still holds', () => {
    const done: SessionNotification = { kind: 'done', title: 'orbital', body: 'Done', sessionId: 's1' }
    expect(bannerLine(done, verdict({ input: { command: 'npm test' } }))).toBe('Done')
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
  // A stop is reported once it has settled; an end or a failure a microtask after its frame.
  const settled = () => {
    vi.advanceTimersByTime(NEEDS_INPUT_SETTLE_MS)
    return new Promise<void>((resolve) => queueMicrotask(resolve))
  }

  let client: FakeClient
  /** A new tunnel: the notifier is renewed and seeded from what the store holds now. */
  const open = () => client.emit({ type: 'ready', ready: true })
  beforeEach(() => {
    vi.useFakeTimers()
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
    vi.useRealTimers()
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

  it('shows a finished turn as a plain Done banner, whatever decision the store still holds', async () => {
    open()
    useOrbital.setState({ pendingDecisions: { s1: ask } })
    client.emit({ type: 'hub', frame: upsert('working') })
    client.emit({ type: 'hub', frame: status('needs_input') })
    await settled()
    expect(useBanner.getState().current).toMatchObject({ sessionId: 's1', needsInput: false, line: 'Done' })
  })

  it('shows nothing for a turn that ends only for a moment', async () => {
    open()
    client.emit({ type: 'hub', frame: upsert('working') })
    client.emit({ type: 'hub', frame: status('needs_input') })
    client.emit({ type: 'hub', frame: status('working') })
    await settled()
    expect(useBanner.getState().current).toBeNull()
  })

  it('shows nothing for a stop still settling when the tunnel drops', async () => {
    open()
    client.emit({ type: 'hub', frame: upsert('working') })
    client.emit({ type: 'hub', frame: status('needs_input') })
    client.emit({ type: 'ready', ready: false })
    await settled()
    expect(useBanner.getState().current).toBeNull()
  })

  it('reports an end at once, in step with its frame', async () => {
    open()
    client.emit({ type: 'hub', frame: upsert('working') })
    client.emit({ type: 'hub', frame: status('ended') })
    expect(useBanner.getState().current).toBeNull()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(useBanner.getState().current).toMatchObject({ sessionId: 's1', needsInput: false, line: 'Session ended' })
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
    expect(useBanner.getState().current).toMatchObject({ sessionId: 's1', title: 'orbital', needsInput: false, line: 'Done' })
  })

  it("seeds from the Mac's list once resync has read it", async () => {
    open()
    seedNotifications([row()])
    client.emit({ type: 'hub', frame: status('needs_input') })
    await settled()
    expect(useBanner.getState().current?.sessionId).toBe('s1')
  })

  it('reports a stop of an unseeded session — a status frame is never a replay', async () => {
    open()
    client.emit({ type: 'hub', frame: status('needs_input') })
    await settled()
    expect(useBanner.getState().current).toMatchObject({ sessionId: 's1', needsInput: false })
  })

  it('reports nothing for an unseeded session whose first upsert is old news', async () => {
    open()
    client.emit({ type: 'hub', frame: upsert('needs_input') })
    await settled()
    expect(useBanner.getState().current).toBeNull()
  })

  it('a member that comes back relists as a seed: no notification for what changed while it was away', async () => {
    open()
    client.emit({ type: 'hub', frame: upsert('working') })
    // The federation's relist of a member back from away: the session started asking meanwhile.
    client.emit({ type: 'hub', frame: { ...upsert('needs_input', ask), replay: true } })
    await settled()
    expect(useBanner.getState().current).toBeNull()
    // What it says live afterwards is news.
    client.emit({ type: 'hub', frame: status('working') })
    client.emit({ type: 'hub', frame: status('needs_input') })
    await settled()
    expect(useBanner.getState().current).toMatchObject({ sessionId: 's1', needsInput: true })
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

  describe('in the background', () => {
    beforeEach(() => {
      setActive(false)
      vi.mocked(postLocalNotification).mockClear()
      vi.mocked(removeDeliveredNotification).mockClear()
    })
    afterEach(() => setActive(true))

    it('takes a question off the shade once its session moves on', async () => {
      useOrbital.setState({ sessions: { s1: row() } })
      open()
      client.emit({ type: 'hub', frame: status('needs_input') })
      await settled()
      expect(postLocalNotification).toHaveBeenCalledTimes(1)
      client.emit({ type: 'hub', frame: upsert('needs_input') })
      expect(removeDeliveredNotification).not.toHaveBeenCalled()
      client.emit({ type: 'hub', frame: status('working') })
      expect(removeDeliveredNotification).toHaveBeenCalledWith(notificationId('s1'))
      client.emit({ type: 'hub', frame: status('idle') })
      expect(removeDeliveredNotification).toHaveBeenCalledTimes(1)
    })

    it('posts nothing while the Mac says the user is at it, and again once the tunnel drops', async () => {
      useOrbital.setState({ sessions: { s1: row() } })
      open()
      client.emit({ type: 'hub', frame: { topic: 'presence', event: 'state', atMac: true } })
      client.emit({ type: 'hub', frame: status('needs_input') })
      await settled()
      expect(postLocalNotification).not.toHaveBeenCalled()
      client.emit({ type: 'ready', ready: false })
      open()
      client.emit({ type: 'hub', frame: status('working') })
      client.emit({ type: 'hub', frame: status('needs_input') })
      await settled()
      expect(postLocalNotification).toHaveBeenCalledTimes(1)
    })
  })

  it('subscribes to presence on every tunnel', () => {
    open()
    expect(client.subscribe).toHaveBeenCalledWith('presence')
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
