import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GroupMember, RemoteStatus } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { useOrbital } from '../store/store'
import { DevicesSection } from '../panels/DevicesSection'

// Settings → Devices (spec 2026-10-16-device-group-design, canvas 50a): the
// branching of the member list, the relay field and Leave.

const NOW = Date.now()

function member(patch: Partial<GroupMember>): GroupMember {
  return {
    id: 'm', kind: 'desktop', name: 'm', os: 'macos', links: true,
    epoch: 1, addedBy: 'self', addedAt: NOW, describedAt: NOW,
    self: false, linked: true, online: true, pairByHand: false, state: 'online', seenAt: null,
    ...patch,
  }
}

const SELF = member({ id: 'self', name: 'studio', self: true, state: 'self' })

function status(others: GroupMember[], patch: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    enabled: true, relay: 'online', relayTooOld: null, relayAttempts: 0, relayUrl: 'https://relay.test',
    macId: 'self', macName: 'studio', devices: [],
    pendingPair: null, pairing: null, joining: null, error: null,
    group: { members: [SELF, ...others], relayLocked: others.length > 0 },
    ...patch,
  }
}

const patchAndSet = vi.fn(async () => {})

function renderWith(remote: RemoteStatus) {
  useOrbital.setState({
    remote,
    toast: null,
    settings: { remote_enabled: 'true', remote_relay_url: remote.relayUrl },
  })
  return render(<DevicesSection patchAndSet={patchAndSet} onSaved={vi.fn()} />)
}

async function openRelay() {
  await userEvent.click(screen.getByRole('button', { name: 'Change relay' }))
  return screen.getByLabelText<HTMLInputElement>('Relay URL')
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.startPairing).mockResolvedValue({ qr: '{"v":1}', expiresAt: Date.now() + 120_000 })
  vi.mocked(api.removeDevice).mockResolvedValue(true)
})

describe('DevicesSection', () => {
  it('lists a phone paired today as a member, and its Remove revokes it after the confirm', async () => {
    const phone = member({ id: 'p1', name: 'Pixel 8', kind: 'phone', os: 'android', links: false })
    renderWith(status([phone], { devices: [] }))
    const row = screen.getByText('Pixel 8').closest('[data-member]') as HTMLElement
    expect(within(row).getByText('phone · Android')).toBeInTheDocument()

    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    expect(api.removeDevice).not.toHaveBeenCalled()
    expect(within(row).getByText(/It drops out of every device in the group now/)).toBeInTheDocument()
    await userEvent.click(within(row).getAllByRole('button', { name: 'Remove' }).at(-1)!)
    expect(api.removeDevice).toHaveBeenCalledWith('p1')
  })

  it('keeps Remove working while the relay is offline', async () => {
    const box = member({ id: 'b1', name: 'build-box', kind: 'headless', os: 'linux', state: 'offline', online: false })
    renderWith(status([box], { relay: 'connecting' }))
    const row = screen.getByText('build-box').closest('[data-member]') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    await userEvent.click(within(row).getAllByRole('button', { name: 'Remove' }).at(-1)!)
    expect(api.removeDevice).toHaveBeenCalledWith('b1')
  })

  it('alone: just this device, no Leave, and the relay can be changed', async () => {
    renderWith(status([]))
    expect(screen.getByText('Just this device')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Leave…' })).not.toBeInTheDocument()
    const relay = await openRelay()
    expect(relay).not.toHaveAttribute('readonly')
    await userEvent.clear(relay)
    await userEvent.type(relay, 'https://other.test{Enter}')
    expect(patchAndSet).toHaveBeenCalledWith({ remote_relay_url: 'https://other.test' })
  })

  it('in a group: the relay is read-only and Leave is offered', async () => {
    renderWith(status([member({ id: 'b1', name: 'build-box' })]))
    const relay = await openRelay()
    expect(relay).toHaveAttribute('readonly')
    await userEvent.type(relay, 'x{Enter}')
    expect(patchAndSet).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Leave…' })).toBeInTheDocument()
  })

  it('a Leave the relay cannot carry says so and changes nothing else', async () => {
    vi.mocked(api.leaveGroup).mockResolvedValue({ ok: false, error: 'offline' })
    renderWith(status([member({ id: 'b1', name: 'build-box' })]))
    await userEvent.click(screen.getByRole('button', { name: 'Leave…' }))
    expect(screen.getByText(/This device forgets the other 1 and their keys/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(api.leaveGroup).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Connect to the relay to leave — the others have to hear it.')).toBeInTheDocument()
    expect(api.removeDevice).not.toHaveBeenCalled()
    expect(patchAndSet).not.toHaveBeenCalled()
    expect(screen.getByText('build-box')).toBeInTheDocument()
  })

  it('a member that is not linked offers Pair by hand, which draws a code for it', async () => {
    renderWith(status([
      member({ id: 'n1', name: 'mini-office', state: 'notLinked', pairByHand: true, linked: false }),
      member({ id: 'l1', name: 'rpi-lab', kind: 'headless', state: 'linking', linked: false }),
    ]))
    await waitFor(() => expect(api.startPairing).toHaveBeenCalledTimes(1))
    const linking = screen.getByText('rpi-lab').closest('[data-member]') as HTMLElement
    expect(within(linking).getByText('linking…')).toBeInTheDocument()

    const notLinked = screen.getByText('mini-office').closest('[data-member]') as HTMLElement
    await userEvent.click(within(notLinked).getByRole('button', { name: 'not linked — pair by hand' }))
    await waitFor(() => expect(api.startPairing).toHaveBeenCalledTimes(2))
    expect(screen.getByText('ADD A DEVICE · FOR MINI-OFFICE')).toBeInTheDocument()
  })
})
