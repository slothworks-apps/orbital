import { describe, expect, it, vi } from 'vitest'
import type { PermissionState } from '@capacitor/core'
import { parseNotificationSettings } from '@orbital/shared/notifications'
import { phoneTurnOn, shouldOfferPhoneTip } from '../mobile/phoneTip'
import { permissionAfterAsking } from '../mobile/platform/localNotify'

// Spec § 5: the phone's tip and its permission.
describe('the phone tip', () => {
  const OFF = parseNotificationSettings({})

  it('is offered after pairing only while the rules copied from the Mac are all off', () => {
    expect(shouldOfferPhoneTip('pending', OFF)).toBe(true)
    expect(shouldOfferPhoneTip('pending', { ...OFF, needsInput: true })).toBe(false)
    // Rules not read yet, a phone that paired before the tip existed, a tip already gone.
    expect(shouldOfferPhoneTip('pending', null)).toBe(false)
    expect(shouldOfferPhoneTip(null, OFF)).toBe(false)
    expect(shouldOfferPhoneTip('ended', OFF)).toBe(false)
  })

  it('turns on exactly needs input and errors', () => {
    expect(phoneTurnOn(OFF)).toEqual({ ...OFF, needsInput: true, sessionFailed: true })
  })

  it('asks the OS only when it never asked, and never again after a refusal', async () => {
    const ask = vi.fn(async (): Promise<PermissionState> => 'granted')
    expect(await permissionAfterAsking('granted', ask)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    expect(await permissionAfterAsking('denied', ask)).toBe(false)
    // Android's first refusal reads as prompt-with-rationale; asking again would prompt again.
    expect(await permissionAfterAsking('prompt-with-rationale', ask)).toBe(false)
    expect(ask).not.toHaveBeenCalled()
    expect(await permissionAfterAsking('prompt', ask)).toBe(true)
    ask.mockResolvedValueOnce('denied')
    expect(await permissionAfterAsking('prompt', ask)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(2)
  })
})
