import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RemoteStatus } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { useOrbital } from '../store/store'
import { PairConfirmDialog } from '../panels/PairConfirmDialog'
import { pairingCodeInput } from '../ui/PairingCodeInput'

// The device group's join confirmation, where the user types the code the
// joining device shows (spec 2026-10-16-device-group-design § 3, canvas 50c).

function remote(pendingPair: RemoteStatus['pendingPair'], attemptsLeft = 3): RemoteStatus {
  return {
    enabled: true, relay: 'online', relayTooOld: null, relayAttempts: 0, relayUrl: 'https://relay.test',
    macId: 'mac', macName: 'studio', devices: [],
    pendingPair: pendingPair && { ...pendingPair, attemptsLeft },
    pairing: { expiresAt: Date.now() + 100_000 },
    joining: null,
    error: null,
    group: { members: [], relayLocked: false },
  }
}

const phonePending = { phone: 'p1', name: 'Pixel 8', platform: 'android', kind: 'phone', attemptsLeft: 3 }
const desktopPending = { phone: 'p2', name: 'imac-home', platform: 'macos', kind: 'desktop', attemptsLeft: 3 }
const headlessPending = { phone: 'p3', name: 'build-box', platform: 'linux', kind: 'headless', attemptsLeft: 3 }

beforeEach(() => {
  vi.clearAllMocks()
  useOrbital.setState({ remote: remote(phonePending), toast: null })
})

const accept = () => screen.getByRole('button', { name: 'Accept' })
const field = () => screen.getByLabelText<HTMLInputElement>('Pairing code')

describe('pairingCodeInput', () => {
  it('keeps the code as the phone spells it, whatever was typed or pasted', () => {
    expect(pairingCodeInput('k7f-q2m')).toBe('K7FQ2M')
    expect(pairingCodeInput('o1l i')).toBe('0111')
    expect(pairingCodeInput('AB!C DEF GH')).toBe('ABCDEF')
  })
})

describe('PairConfirmDialog', () => {
  it('names a desktop request with its kind and OS, twice over', () => {
    useOrbital.setState({ remote: remote(desktopPending) })
    render(<PairConfirmDialog />)
    expect(screen.getByText('imac-home (desktop, macOS) wants to join')).toBeInTheDocument()
    expect(screen.getByText('DESKTOP')).toBeInTheDocument()
  })

  it('names a headless request with its kind and OS, twice over', () => {
    useOrbital.setState({ remote: remote(headlessPending) })
    render(<PairConfirmDialog />)
    expect(screen.getByText('build-box (headless, Linux) wants to join')).toBeInTheDocument()
    expect(screen.getByText('HEADLESS SERVER')).toBeInTheDocument()
  })

  it("a shipped phone's request (kind read as phone) names it too", () => {
    useOrbital.setState({ remote: remote(phonePending) })
    render(<PairConfirmDialog />)
    expect(screen.getByText('Pixel 8 (phone, Android) wants to join')).toBeInTheDocument()
    expect(screen.getByText('PHONE')).toBeInTheDocument()
  })

  it('accepts only with all six in, and sends the code the user typed', async () => {
    vi.mocked(api.confirmPairing).mockResolvedValue({ ok: true })
    render(<PairConfirmDialog />)
    expect(accept()).toBeDisabled()
    await userEvent.type(field(), 'k7fq2')
    expect(accept()).toBeDisabled()
    await userEvent.type(field(), 'm')
    expect(accept()).toBeEnabled()
    await userEvent.click(accept())
    expect(api.confirmPairing).toHaveBeenCalledWith(true, 'p1', 'K7FQ2M')
    expect(await screen.findByText('Pixel 8 joined')).toBeInTheDocument()
  })

  it('the joined screen closes on Done', async () => {
    vi.mocked(api.confirmPairing).mockResolvedValue({ ok: true })
    render(<PairConfirmDialog />)
    await userEvent.type(field(), 'K7FQ2M')
    await userEvent.click(accept())
    await screen.findByText('Pixel 8 joined')
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByText('Pixel 8 joined')).not.toBeInTheDocument())
  })

  it('takes a pasted code with its dash', async () => {
    render(<PairConfirmDialog />)
    await userEvent.click(field())
    await userEvent.paste('abc-def')
    expect(field().value).toBe('ABCDEF')
    expect(accept()).toBeEnabled()
  })

  it('a wrong code clears the boxes and says how many attempts are left', async () => {
    vi.mocked(api.confirmPairing).mockResolvedValueOnce({ error: 'code_mismatch', attemptsLeft: 2 })
    vi.mocked(api.confirmPairing).mockResolvedValueOnce({ error: 'code_mismatch', attemptsLeft: 1 })
    render(<PairConfirmDialog />)
    await userEvent.type(field(), 'AAAAAA{Enter}')
    expect(await screen.findByText('That code didn’t match · 2 attempts left')).toBeInTheDocument()
    expect(field().value).toBe('')
    expect(accept()).toBeDisabled()
    await userEvent.type(field(), 'BBBBBB{Enter}')
    expect(await screen.findByText('That code didn’t match · 1 attempt left')).toBeInTheDocument()
  })

  it('the last wrong code ends in a rejection', async () => {
    vi.mocked(api.confirmPairing).mockResolvedValue({ error: 'code_rejected' })
    render(<PairConfirmDialog />)
    await userEvent.type(field(), 'AAAAAA')
    await userEvent.click(accept())
    await waitFor(() => expect(useOrbital.getState().toast?.message).toMatch(/^Request rejected/))
  })

  it('closing is Reject, and Reject needs no code', async () => {
    vi.mocked(api.confirmPairing).mockResolvedValue({ ok: true })
    render(<PairConfirmDialog />)
    await userEvent.keyboard('{Escape}')
    expect(api.confirmPairing).toHaveBeenCalledWith(false, 'p1')
  })
})
