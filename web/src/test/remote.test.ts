import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { api, ApiError } from '../lib/api'
import type { RemoteStatus } from '../lib/types'
import {
  PAIRING_WINDOW_MS,
  RELAY_UNREACHABLE_AFTER_ATTEMPTS,
  codeLeft,
  relayLine,
  relaySecretCommit,
  relayUrlCommit,
} from '../lib/remote'

function status(patch: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    enabled: true,
    relay: 'connecting',
    relayAttempts: 0,
    relayUrl: 'https://relay.example.org:8443/path',
    macId: 'mac',
    macName: 'Studio',
    devices: [],
    pendingPair: null,
    pairing: null,
    error: null,
    ...patch,
  }
}

describe('relayLine', () => {
  it('is off while the remote is off', () => {
    expect(relayLine(status({ enabled: false, relay: 'off' })).kind).toBe('off')
  })

  it('reads as connecting until the attempts reach the threshold', () => {
    const line = relayLine(status({ relayAttempts: RELAY_UNREACHABLE_AFTER_ATTEMPTS - 1 }))
    expect(line.kind).toBe('connecting')
    expect(line.text).toBe('connecting to relay…')
  })

  it('reads as unreachable from the threshold on', () => {
    const line = relayLine(status({ relayAttempts: RELAY_UNREACHABLE_AFTER_ATTEMPTS }))
    expect(line.kind).toBe('unreachable')
    expect(line.text).toBe("can't reach the relay")
  })

  it('names only the relay host when online', () => {
    const line = relayLine(status({ relay: 'online', relayAttempts: 5 }))
    expect(line).toEqual({ kind: 'online', text: 'online · relay.example.org' })
  })

  it('falls back to the URL as written when it does not parse', () => {
    expect(relayLine(status({ relay: 'online', relayUrl: 'not a url' })).text).toBe('online · not a url')
  })

  it('names no host when the status carries no relay URL', () => {
    expect(relayLine(status({ relay: 'online', relayUrl: '' })).text).toBe('online')
  })

  it('lets a start error win over the relay state, carrying the reason verbatim', () => {
    const line = relayLine(status({ relay: 'off', error: 'Invalid URL: ftp:/x' }))
    expect(line).toEqual({ kind: 'failed', text: "couldn't start", detail: 'Invalid URL: ftp:/x' })
  })
})

describe('codeLeft', () => {
  const now = 1_000_000

  it('counts down in m:ss, rounding a part second up', () => {
    expect(codeLeft(now + 108_400, now).label).toBe('1:49')
    expect(codeLeft(now + 5_000, now).label).toBe('0:05')
  })

  it('drains the fraction over the pairing window', () => {
    expect(codeLeft(now + PAIRING_WINDOW_MS, now).fraction).toBe(1)
    expect(codeLeft(now + PAIRING_WINDOW_MS / 2, now).fraction).toBeCloseTo(0.5)
    // A relay clock ahead of ours must not overfill the bar.
    expect(codeLeft(now + PAIRING_WINDOW_MS * 2, now).fraction).toBe(1)
  })

  it('is expired at and after expiresAt', () => {
    expect(codeLeft(now, now)).toEqual({ label: '0:00', fraction: 0, expired: true })
    expect(codeLeft(now - 3_000, now)).toEqual({ label: '0:00', fraction: 0, expired: true })
    expect(codeLeft(now + 1, now).expired).toBe(false)
  })
})

describe('relayUrlCommit', () => {
  it('does nothing when the trimmed value is what is saved', () => {
    expect(relayUrlCommit('https://a.example', '  https://a.example ', 3)).toBe('none')
    expect(relayUrlCommit('', '   ', 3)).toBe('none')
  })

  it('saves straight away with no phone paired', () => {
    expect(relayUrlCommit('', 'https://b.example', 0)).toBe('save')
  })

  it('asks first when phones are paired', () => {
    expect(relayUrlCommit('', 'https://b.example', 2)).toBe('ask')
    expect(relayUrlCommit('https://b.example', '', 1)).toBe('ask')
  })

  it('cannot decide a change before the phones are known', () => {
    expect(relayUrlCommit('', 'https://b.example', null)).toBe('unknown')
    expect(relayUrlCommit('https://b.example', ' https://b.example ', null)).toBe('none')
  })
})

describe('relaySecretCommit', () => {
  it('does nothing when the trimmed value is what is saved', () => {
    expect(relaySecretCommit('s3cret', ' s3cret ', 2)).toBe('none')
    expect(relaySecretCommit('', '  ', null)).toBe('none')
  })

  it('saves straight away with no phone paired', () => {
    expect(relaySecretCommit('', 's3cret', 0)).toBe('save')
  })

  it('asks first when a changed secret would strand paired phones', () => {
    expect(relaySecretCommit('', 's3cret', 2)).toBe('ask')
    expect(relaySecretCommit('old', 'new', 1)).toBe('ask')
  })

  it('saves a cleared secret without asking: an open relay takes the one the phones hold', () => {
    expect(relaySecretCommit('s3cret', '', 3)).toBe('save')
    expect(relaySecretCommit('s3cret', '  ', null)).toBe('save')
  })

  it('cannot decide a change before the phones are known', () => {
    expect(relaySecretCommit('old', 'new', null)).toBe('unknown')
  })
})

describe('remote api', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function answer(code: number, body: unknown) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: code }))
  }

  describe('confirmPairing', () => {
    it('posts accept and phone and answers ok', async () => {
      answer(200, { ok: true })
      await expect(api.confirmPairing(true, 'phone-1')).resolves.toEqual({ ok: true })
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/remote/pair/confirm')
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body as string)).toEqual({ accept: true, phone: 'phone-1' })
    })

    it.each([
      [404, 'no_pending'],
      [409, 'mismatch'],
      [502, 'relay_error'],
    ])('maps %i to %s instead of throwing', async (code, error) => {
      answer(code, { error })
      await expect(api.confirmPairing(false, 'phone-1')).resolves.toEqual({ error })
    })

    it('throws ApiError outside the contract', async () => {
      answer(400, { error: 'phone must be a string' })
      await expect(api.confirmPairing(true, 'phone-1')).rejects.toBeInstanceOf(ApiError)
    })

    it('throws ApiError for a contract status whose body is not the contract', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      await expect(api.confirmPairing(true, 'phone-1')).rejects.toBeInstanceOf(ApiError)
    })
  })

  describe('startPairing', () => {
    it('returns a 409 refusal as a value', async () => {
      answer(409, { error: 'offline' })
      await expect(api.startPairing()).resolves.toEqual({ error: 'offline' })
    })

    it('throws ApiError outside the contract', async () => {
      answer(500, { error: 'boom' })
      await expect(api.startPairing()).rejects.toBeInstanceOf(ApiError)
    })
  })

  describe('removeDevice', () => {
    it('treats a 404 as already done', async () => {
      answer(404, { error: 'not_found' })
      await expect(api.removeDevice('gone')).resolves.toBe(false)
    })

    it('answers true when it removed one', async () => {
      answer(200, { ok: true })
      await expect(api.removeDevice('phone-1')).resolves.toBe(true)
      expect(fetchMock.mock.calls[0][0]).toBe('/api/remote/devices/phone-1')
    })
  })
})
