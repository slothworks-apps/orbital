import { describe, expect, it } from 'vitest'
import { parseNotificationSettings } from '@orbital/shared/notifications'
import { notificationRowPatch, shouldOfferNotificationsTip, turnOnPatch } from '../lib/notificationsTip'
import { dequeueNotice, enqueueNotice, type MapNoticeEntry } from '../store/mapNotices'

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

describe('map notice queue', () => {
  const entry = (id: string): MapNoticeEntry => ({ id, Body: () => null })

  it('keeps arrival order, ignores an id already queued, and drops by id', () => {
    const a = entry('a')
    let queue = enqueueNotice([], a)
    queue = enqueueNotice(queue, entry('b'))
    queue = enqueueNotice(queue, entry('a'))
    expect(queue.map((e) => e.id)).toEqual(['a', 'b'])
    expect(queue[0]).toBe(a)
    expect(dequeueNotice(queue, 'a').map((e) => e.id)).toEqual(['b'])
    expect(dequeueNotice(queue, 'zzz')).toBe(queue)
  })
})
