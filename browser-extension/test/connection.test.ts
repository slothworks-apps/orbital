import { describe, expect, it } from 'vitest'
import { browserNameFromBrands } from '../src/browserName'
import {
  decideOnClose,
  outcomeText,
  RECONNECT_BASE_MS,
  RECONNECT_DISABLED_MS,
  RECONNECT_MAX_MS,
  reconnectDelay,
} from '../src/connection'
import { BROWSER_CLOSE } from '../src/protocol'

describe('decideOnClose', () => {
  it('forgets a token the server no longer knows and stops', () => {
    expect(decideOnClose(BROWSER_CLOSE.unauthorized, true)).toEqual({
      status: 'unpaired',
      forgetToken: true,
      retry: false,
    })
  })

  it('keeps the token while the switch is off and keeps asking', () => {
    expect(decideOnClose(BROWSER_CLOSE.disabled, true)).toEqual({
      status: 'disabled',
      forgetToken: false,
      retry: true,
    })
  })

  it('retries any other close while paired', () => {
    for (const code of [1000, 1001, 1006, 1011]) {
      expect(decideOnClose(code, true)).toEqual({
        status: 'offline',
        forgetToken: false,
        retry: true,
      })
    }
  })

  it('has nothing to retry with when a pairing attempt fails to connect', () => {
    expect(decideOnClose(1006, false)).toEqual({
      status: 'offline',
      forgetToken: false,
      retry: false,
    })
    expect(decideOnClose(BROWSER_CLOSE.disabled, false).retry).toBe(false)
  })
})

describe('reconnectDelay', () => {
  it('backs off exponentially up to a ceiling', () => {
    expect(reconnectDelay(0, 'offline')).toBe(RECONNECT_BASE_MS)
    expect(reconnectDelay(1, 'offline')).toBe(RECONNECT_BASE_MS * 2)
    expect(reconnectDelay(3, 'offline')).toBe(RECONNECT_BASE_MS * 8)
    expect(reconnectDelay(50, 'offline')).toBe(RECONNECT_MAX_MS)
  })

  it('waits the long interval while the switch is off', () => {
    expect(reconnectDelay(0, 'disabled')).toBe(RECONNECT_DISABLED_MS)
  })
})

describe('outcomeText', () => {
  it('names the session a screenshot went to, or why it was not sent', () => {
    expect(outcomeText({ delivered: true, sessionTitle: 'web-onboarding' })).toBe(
      'Sent to web-onboarding',
    )
    expect(outcomeText({ delivered: true })).toBe('Sent to Orbital')
    expect(outcomeText({ delivered: false, reason: 'no-session' })).toBe(
      'Nothing open in Orbital — not sent',
    )
    expect(outcomeText({ delivered: false })).toBe('Nothing open in Orbital — not sent')
    expect(outcomeText({ delivered: false, reason: 'composer-full' })).toBe(
      'The composer is full — not sent',
    )
  })
})

describe('browserNameFromBrands', () => {
  it('names the browser behind the GREASE and Chromium entries', () => {
    expect(
      browserNameFromBrands([
        { brand: 'Not)A;Brand' },
        { brand: 'Chromium' },
        { brand: 'Google Chrome' },
      ]),
    ).toBe('Chrome')
    expect(browserNameFromBrands([{ brand: 'Microsoft Edge' }, { brand: 'Chromium' }])).toBe('Edge')
    expect(browserNameFromBrands([{ brand: 'Chromium' }, { brand: 'Not_A Brand' }])).toBe(
      'Chromium',
    )
    expect(browserNameFromBrands(undefined)).toBe('Chromium browser')
  })
})
