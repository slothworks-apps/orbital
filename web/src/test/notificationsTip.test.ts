import { describe, expect, it } from 'vitest'
import { parseNotificationSettings } from '@orbital/shared/notifications'
import { notificationRowPatch, shouldOfferNotificationsTip, turnOnPatch } from '../lib/notificationsTip'
import { dequeueNotice, enqueueNotice, noticeDots, type NoticeEntry, type NoticeKind } from '../lib/noticeQueue'

// Spec 2026-10-08-notifications-off-by-default-design § 3.
const FRESH = {
  notify_needs_input: 'false',
  notify_session_ended: 'false',
  notify_session_failed: 'false',
  notify_only_when_background: 'true',
  notify_sound: 'false',
  notify_tip: 'pending',
}

describe('shouldOfferNotificationsTip', () => {
  it('waits for the first session: never on an empty first launch', () => {
    expect(shouldOfferNotificationsTip(FRESH, [])).toBe(false)
    expect(shouldOfferNotificationsTip(FRESH, [{ status: 'ended' }])).toBe(false)
    expect(shouldOfferNotificationsTip(FRESH, [{ status: 'ended' }, { status: 'working' }])).toBe(true)
  })

  it('is never offered once ended, on an existing install, or before settings load', () => {
    const live = [{ status: 'needs_input' }]
    expect(shouldOfferNotificationsTip({ ...FRESH, notify_tip: 'ended' }, live)).toBe(false)
    // An existing install's tip row is `ended`; one with no row at all is not pending either.
    const { notify_tip: _, ...noTip } = FRESH
    expect(shouldOfferNotificationsTip(noTip, live)).toBe(false)
    expect(shouldOfferNotificationsTip({}, live)).toBe(false)
  })

  it('is never offered while anything already notifies', () => {
    expect(shouldOfferNotificationsTip({ ...FRESH, notify_needs_input: 'true' }, [{ status: 'working' }])).toBe(false)
    expect(shouldOfferNotificationsTip({ ...FRESH, notify_sound: 'true' }, [{ status: 'working' }])).toBe(false)
  })
})

describe('turnOnPatch', () => {
  it('switches on exactly needs input and session failed, leaving sound and session ended off', () => {
    const after = parseNotificationSettings({ ...FRESH, ...turnOnPatch('granted') })
    expect(after).toEqual({ needsInput: true, sessionEnded: false, sessionFailed: true, onlyWhenBackground: true, sound: false })
    expect(turnOnPatch('granted').notify_tip).toBe('ended')
  })

  it('counts an unanswered prompt as yes', () => {
    expect(turnOnPatch('unknown')).toEqual(turnOnPatch('granted'))
  })

  it('switches nothing on when macOS refuses, and still ends the tip', () => {
    expect(turnOnPatch('denied')).toEqual({ notify_tip: 'ended' })
  })
})

describe('notificationRowPatch', () => {
  it('saves the row and ends the tip with it', () => {
    expect(notificationRowPatch('sound', true)).toEqual({ notify_sound: 'true', notify_tip: 'ended' })
    expect(notificationRowPatch('onlyWhenBackground', false)).toEqual({
      notify_only_when_background: 'false',
      notify_tip: 'ended',
    })
  })
})

// Canvas `Feature - Notice toast`: one at a time, by kind then age, and dots for the rest.
describe('notice queue', () => {
  const entry = (id: string, kind: NoticeKind, at: number): NoticeEntry => ({ id, kind, at, Body: () => null })

  it('shows by kind first — update › changelog › pairing › usage › tip — then oldest first', () => {
    let queue: readonly NoticeEntry[] = []
    queue = enqueueNotice(queue, entry('tip-1', 'tip', 1))
    queue = enqueueNotice(queue, entry('usage', 'usage', 2))
    queue = enqueueNotice(queue, entry('tip-0', 'tip', 0))
    queue = enqueueNotice(queue, entry('update', 'update', 3))
    queue = enqueueNotice(queue, entry('changelog', 'changelog', 4))
    queue = enqueueNotice(queue, entry('pairing', 'pairing', 5))
    expect(queue.map((e) => e.id)).toEqual(['update', 'changelog', 'pairing', 'usage', 'tip-0', 'tip-1'])
  })

  it('ignores an id already queued and drops by id', () => {
    const first = entry('a', 'tip', 1)
    let queue = enqueueNotice([], first)
    queue = enqueueNotice(queue, entry('a', 'update', 0))
    expect(queue).toEqual([first])
    expect(dequeueNotice(queue, 'a')).toEqual([])
    expect(dequeueNotice(queue, 'zzz')).toBe(queue)
  })

  it('draws no dots for one message, one per message up to five, then the rest as a number', () => {
    expect(noticeDots(0)).toEqual({ dots: [], more: 0 })
    expect(noticeDots(1)).toEqual({ dots: [], more: 0 })
    expect(noticeDots(2)).toEqual({ dots: ['current', 'waiting'], more: 0 })
    expect(noticeDots(5).dots).toHaveLength(5)
    expect(noticeDots(5).more).toBe(0)
    expect(noticeDots(8)).toEqual({ dots: ['current', 'waiting', 'waiting', 'waiting', 'waiting'], more: 3 })
  })
})
