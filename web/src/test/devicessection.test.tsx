import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { deviceId, generateIdentity, toBase64Url } from '@orbital/shared/remote/keys'
import { encodePairingCode } from '@orbital/shared/remote/relayApi'
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
    addedAt: NOW, addedVersion: 1, primary: false,
    self: false, linked: true, online: true, pairByHand: false, state: 'online', seenAt: null, tooOld: false,
    ...patch,
  }
}

const SELF = member({ id: 'self', name: 'studio', self: true, state: 'self' })

/** This device with `others` in its group, as their primary; alone with none. */
function status(others: GroupMember[], patch: Partial<RemoteStatus> = {}): RemoteStatus {
  const grouped = others.length > 0
  return {
    enabled: true, relay: 'online', relayTooOld: null, relayAttempts: 0, relayUrl: 'https://relay.test',
    macId: 'self', macName: 'studio', devices: [],
    pendingPair: null, pairing: null, joining: null, error: null,
    group: {
      members: [SELF, ...others], relayLocked: grouped,
      primary: grouped ? { id: 'self', name: 'studio' } : null, isPrimary: grouped, ended: null, pendingJoin: null,
    },
    ...patch,
  }
}

const BUILD = { id: 'b1', name: 'build-box' }

/** `status`, on a member of `primary`'s group rather than its primary. */
function asMember(remote: RemoteStatus, primary = BUILD): RemoteStatus {
  return { ...remote, group: { ...remote.group, primary, isPrimary: false } }
}

const patchAndSet = vi.fn(async (_patch: Record<string, string>) => true)

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

  it('on a member: the relay is read-only, Leave is offered, and the primary is named where the add box was', async () => {
    renderWith(asMember(status([member({ id: 'b1', name: 'build-box', primary: true })])))
    const relay = await openRelay()
    expect(relay).toHaveAttribute('readonly')
    await userEvent.type(relay, 'x{Enter}')
    expect(patchAndSet).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Leave…' })).toBeInTheDocument()
    expect(screen.getByText(/manages this group — add and remove devices there\./)).toBeInTheDocument()
    expect(screen.queryByLabelText("Another device's code")).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })

  it('on the primary: Remove on each row and Dissolve, with no Leave', async () => {
    vi.mocked(api.leaveGroup).mockResolvedValue({ ok: true })
    renderWith(status([member({ id: 'b1', name: 'build-box' }), member({ id: 'b2', name: 'rpi-lab' })]))
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Leave…' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Dissolve…' }))
    expect(screen.getByText(/All 2 other devices become standalone/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Dissolve' }))
    expect(api.leaveGroup).toHaveBeenCalledTimes(1)
  })

  it('heads the list with the notice of the group ending until OK', async () => {
    vi.mocked(api.acknowledgeEnded).mockResolvedValue(undefined)
    renderWith(status([], {
      group: {
        members: [SELF], relayLocked: false, primary: null, isPrimary: false,
        ended: { why: 'removed', by: { id: 'b1', name: 'build-box' } }, pendingJoin: null,
      },
    }))
    expect(screen.getByText('build-box removed this device from the group')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(api.acknowledgeEnded).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('build-box removed this device from the group')).not.toBeInTheDocument()
  })

  it('a Leave the relay cannot carry says so and changes nothing else', async () => {
    vi.mocked(api.leaveGroup).mockResolvedValue({ ok: false, error: 'offline' })
    renderWith(asMember(status([member({ id: 'b1', name: 'build-box' })])))
    await userEvent.click(screen.getByRole('button', { name: 'Leave…' }))
    expect(screen.getByText(/This device becomes standalone and forgets the other one/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(api.leaveGroup).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Connect to the relay to leave — the others have to hear it.')).toBeInTheDocument()
    expect(api.removeDevice).not.toHaveBeenCalled()
    expect(patchAndSet).not.toHaveBeenCalled()
    expect(document.querySelector('[data-member="b1"]')).not.toBeNull()
  })

  it('with one other device, Leave speaks of it in the singular; with more, in the plural', async () => {
    const { unmount } = renderWith(asMember(status([member({ id: 'b1', name: 'build-box' })])))
    await userEvent.click(screen.getByRole('button', { name: 'Leave…' }))
    expect(screen.getByText('This device becomes standalone and forgets the other one. To join again, pair it with build-box.'))
      .toBeInTheDocument()
    unmount()
    renderWith(asMember(status([member({ id: 'b1', name: 'build-box' }), member({ id: 'b2', name: 'rpi-lab' })])))
    await userEvent.click(screen.getByRole('button', { name: 'Leave…' }))
    expect(screen.getByText(/This device becomes standalone and forgets the other 2\./)).toBeInTheDocument()
  })

  it('a Mac with only its phones changes the relay after the confirm that removes them', async () => {
    const phone = member({ id: 'p1', name: 'Pixel 8', kind: 'phone', os: 'android', links: false })
    renderWith(status([phone], {
      group: { members: [SELF, phone], relayLocked: false, primary: null, isPrimary: false, ended: null, pendingJoin: null },
      devices: [{
        id: 'p1', name: 'Pixel 8', platform: 'android', kind: 'phone', pairedAt: NOW, lastSeenAt: null, online: true,
        needsUpdate: null,
      }],
    }))
    const relay = await openRelay()
    expect(relay).not.toHaveAttribute('readonly')
    await userEvent.clear(relay)
    await userEvent.type(relay, 'https://other.test{Enter}')
    expect(patchAndSet).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Change and remove' }))
    expect(api.removeDevice).toHaveBeenCalledWith('p1')
    expect(patchAndSet).toHaveBeenCalledWith({ remote_relay_url: 'https://other.test' })
  })

  it('the add box offers no server command until one exists', () => {
    renderWith(status([]))
    expect(screen.queryByText(/orbital join/)).not.toBeInTheDocument()
    expect(screen.getByText(/paste it in Devices there/)).toBeInTheDocument()
  })

  it('on a member, a row not linked reads not linked, with no Pair by hand: only the primary pairs by hand', () => {
    renderWith(asMember(status([member({ id: 'n1', name: 'mini-office', state: 'notLinked', pairByHand: true, linked: false })])))
    const row = screen.getByText('mini-office').closest('[data-member]') as HTMLElement
    expect(within(row).getByText('not linked')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /pair by hand/ })).not.toBeInTheDocument()
  })

  it('on the primary, a member that is not linked offers Pair by hand, which draws a code for it', async () => {
    renderWith(status([
      member({ id: 'n1', name: 'mini-office', state: 'notLinked', pairByHand: true, linked: false }),
      member({ id: 'l1', name: 'rpi-lab', kind: 'headless', state: 'linking', linked: false }),
    ]))
    // No code until one is asked for.
    expect(api.startPairing).not.toHaveBeenCalled()
    const linking = screen.getByText('rpi-lab').closest('[data-member]') as HTMLElement
    expect(within(linking).getByText('linking…')).toBeInTheDocument()

    const notLinked = screen.getByText('mini-office').closest('[data-member]') as HTMLElement
    await userEvent.click(within(notLinked).getByRole('button', { name: 'not linked — pair by hand' }))
    await waitFor(() => expect(api.startPairing).toHaveBeenCalledTimes(1))
    expect(screen.getByText('ADD A DEVICE · FOR MINI-OFFICE')).toBeInTheDocument()
  })

  it('draws a code only once Show code is clicked, and Copy waits for it', async () => {
    renderWith(status([]))
    expect(api.startPairing).not.toHaveBeenCalled()
    expect(screen.getByText(/^Add another with the code on the right/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Show code' }))
    expect(api.startPairing).toHaveBeenCalledTimes(1)
  })

  it('a phone refused as too old reads needs an update, even while the relay counts it online', () => {
    const phone = member({ id: 'p1', name: 'Pixel 8', kind: 'phone', os: 'android', links: false, state: 'online' })
    renderWith(status([phone], {
      devices: [{
        id: 'p1', name: 'Pixel 8', platform: 'android', kind: 'phone', pairedAt: NOW, lastSeenAt: NOW, online: true,
        needsUpdate: { version: '0.3.0', needed: '0.4.0', at: NOW },
      }],
    }))
    const row = screen.getByText('Pixel 8').closest('[data-member]') as HTMLElement
    expect(within(row).getByText('needs an update')).toBeInTheDocument()
    expect(within(row).queryByText('online')).not.toBeInTheDocument()
    expect(within(row).getByText(/app 0\.3\.0 · this device needs ≥ 0\.4\.0 · refused · now/)).toBeInTheDocument()
  })

  it('lists a phone paired before the roster existed, and removes it', async () => {
    renderWith(status([], {
      devices: [{
        id: 'old', name: 'Galaxy', platform: 'android', kind: null, pairedAt: NOW, lastSeenAt: null, online: false,
        needsUpdate: null,
      }],
    }))
    expect(screen.queryByText('Just this device')).not.toBeInTheDocument()
    const row = screen.getByText('Galaxy').closest('[data-member]') as HTMLElement
    expect(within(row).getByText('phone · Android')).toBeInTheDocument()
    expect(within(row).getByText('offline')).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    await userEvent.click(within(row).getAllByRole('button', { name: 'Remove' }).at(-1)!)
    expect(api.removeDevice).toHaveBeenCalledWith('old')
  })

  it('the Leave refusal goes once the relay is back', async () => {
    vi.mocked(api.leaveGroup).mockResolvedValue({ ok: false, error: 'offline' })
    const others = [member({ id: 'b1', name: 'build-box' })]
    renderWith(asMember(status(others, { relay: 'connecting' })))
    await userEvent.click(screen.getByRole('button', { name: 'Leave…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }))
    const words = 'Connect to the relay to leave — the others have to hear it.'
    expect(await screen.findByText(words)).toBeInTheDocument()
    act(() => useOrbital.getState().setRemote(asMember(status(others))))
    expect(screen.queryByText(words)).not.toBeInTheDocument()
  })
})

// Joining from this device (canvas 50b, 50d B–D): the pasted code is read
// here first, then the server's answer, then the joining status.
describe('DevicesSection — joining another device\'s group', () => {
  const T0 = new Date('2026-10-17T12:00:00Z').getTime()
  const PEER = deviceId(generateIdentity().publicKey)
  const OWN = deviceId(generateIdentity().publicKey)

  function codeFor(patch: Record<string, unknown> = {}): string {
    return encodePairingCode(JSON.stringify({
      v: 1, relay: 'https://relay.test', mac: PEER, name: 'studio-mbp', token: 'tok',
      secret: toBase64Url(new Uint8Array(16)), kind: 'desktop', expiresAt: T0 + 80_000, ...patch,
    }))
  }

  function joining(patch: Partial<NonNullable<RemoteStatus['joining']>> = {}): RemoteStatus['joining'] {
    return { device: PEER, name: 'studio-mbp', kind: 'desktop', code: 'K7F-Q2M', expiresAt: T0 + 60_000, ...patch }
  }

  /** Flushes the awaited api answer into React. */
  async function settle() {
    await act(async () => {})
  }

  async function paste(code: string) {
    fireEvent.change(screen.getByLabelText("Another device's code"), { target: { value: code } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    await settle()
  }

  function tick(ms: number) {
    act(() => { vi.advanceTimersByTime(ms) })
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
    vi.mocked(api.joinGroup).mockResolvedValue({ ok: true, device: PEER, name: 'studio-mbp', code: 'K7F-Q2M' })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads text that is not a code as such, without asking the server', async () => {
    renderWith(status([]))
    await paste('hello there')
    expect(screen.getByText("That isn't a device code.")).toBeInTheDocument()
    expect(api.joinGroup).not.toHaveBeenCalled()
  })

  it("knows this device's own code without asking the server", async () => {
    renderWith(status([], { macId: OWN }))
    await paste(codeFor({ mac: OWN }))
    expect(screen.getByText("That's this device's own code.")).toBeInTheDocument()
    expect(api.joinGroup).not.toHaveBeenCalled()
  })

  it('catches a code from another relay at paste, and Use <relay> saves it while alone', async () => {
    renderWith(status([]))
    await paste(codeFor({ relay: 'https://relay.lab.internal' }))
    expect(api.joinGroup).not.toHaveBeenCalled()
    expect(screen.getByText('studio-mbp uses another relay')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use relay.lab.internal' }))
    })
    expect(patchAndSet).toHaveBeenCalledWith({ remote_relay_url: 'https://relay.lab.internal' })
  })

  it('in a group, another relay points to leaving instead of switching', async () => {
    renderWith(status([member({ id: 'b1', name: 'build-box' })]))
    await paste(codeFor({ relay: 'https://relay.lab.internal' }))
    expect(screen.getByText('Leave this group first to change relays.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Use / })).not.toBeInTheDocument()
    expect(api.joinGroup).not.toHaveBeenCalled()
  })

  it('takes the same relay with a trailing slash as the same relay', async () => {
    renderWith(status([], { relayUrl: 'https://relay.test/' }))
    const code = codeFor()
    await paste(code)
    expect(api.joinGroup).toHaveBeenCalledWith(code)
  })

  it('a code already run out reads as expired, without asking the server', async () => {
    renderWith(status([]))
    await paste(codeFor({ expiresAt: T0 - 1 }))
    expect(screen.getByText('Code expired')).toBeInTheDocument()
    expect(screen.getByText('Codes last two minutes. Make a new one on studio-mbp and paste it again.')).toBeInTheDocument()
    expect(api.joinGroup).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Paste a new code' }))
    expect(screen.queryByText('Code expired')).not.toBeInTheDocument()
    expect(screen.getByLabelText<HTMLInputElement>("Another device's code").value).toBe('')
  })

  it('a code the relay no longer knows reads as expired', async () => {
    vi.mocked(api.joinGroup).mockResolvedValue({ ok: false, error: 'bad_code' })
    renderWith(status([]))
    await paste(codeFor())
    expect(screen.getByText('Code expired')).toBeInTheDocument()
  })

  it('in a group already: says to leave first', async () => {
    vi.mocked(api.joinGroup).mockResolvedValue({ ok: false, error: 'in_group' })
    renderWith(status([]))
    await paste(codeFor())
    expect(screen.getByText('This device is already in a group. Leave it first, then join.')).toBeInTheDocument()
  })

  it('a relay that does not answer says so', async () => {
    vi.mocked(api.joinGroup).mockResolvedValue({ ok: false, error: 'relay_error' })
    renderWith(status([]))
    await paste(codeFor())
    expect(screen.getByText("The relay didn't answer. Try again.")).toBeInTheDocument()
  })

  it('offline: Try again is one more check and nothing retries by itself; the code running out turns it to expired', async () => {
    vi.mocked(api.joinGroup).mockResolvedValue({ ok: false, error: 'peer_offline', expiresAt: T0 + 80_000 })
    renderWith(status([]))
    await paste(codeFor())
    expect(screen.getByText('studio-mbp is offline')).toBeInTheDocument()
    expect(screen.getByText(/Its code is good for another 1:20 — try again once studio-mbp is awake\./)).toBeInTheDocument()
    expect(api.joinGroup).toHaveBeenCalledTimes(1)

    tick(30_000)
    expect(api.joinGroup).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/good for another 0:50/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(api.joinGroup).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()

    tick(50_000)
    expect(screen.getByText('Code expired')).toBeInTheDocument()
    expect(api.joinGroup).toHaveBeenCalledTimes(2)
  })

  it('while joining: the six characters, the member, the countdown, and Cancel', async () => {
    renderWith(status([], { joining: joining() }))
    expect(screen.getByText('Type K7F-Q2M on studio-mbp')).toBeInTheDocument()
    expect(screen.getByLabelText('Code K7FQ2M')).toBeInTheDocument()
    expect(screen.getByText('· desktop')).toBeInTheDocument()
    expect(screen.getByText('waiting · code expires in 1:00')).toBeInTheDocument()
    // The card takes the add box's place (canvas 50b).
    expect(screen.queryByLabelText("Another device's code")).not.toBeInTheDocument()
    expect(screen.getByText(/^Paste a code from any device in your group/)).toBeInTheDocument()
    tick(15_000)
    expect(screen.getByText('waiting · code expires in 0:45')).toBeInTheDocument()

    vi.mocked(api.cancelJoin).mockResolvedValue(undefined)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settle()
    expect(api.cancelJoin).toHaveBeenCalledTimes(1)
    act(() => useOrbital.getState().setRemote(status([])))
    expect(screen.queryByText('Request rejected')).not.toBeInTheDocument()
    expect(screen.getByLabelText("Another device's code")).toBeInTheDocument()
  })

  it('joining a member by hand names its OS from the roster', () => {
    const known = member({ id: PEER, name: 'studio-mbp', os: 'macos', state: 'notLinked', linked: false })
    renderWith(status([known], { joining: joining() }))
    expect(screen.getByText('· desktop · macOS')).toBeInTheDocument()
  })

  it('accepted: the member appears in the list and no card is left', () => {
    renderWith(status([], { joining: joining() }))
    const joined = member({ id: PEER, name: 'studio-mbp' })
    act(() => useOrbital.getState().setRemote(status([joined])))
    expect(screen.queryByText(/Type K7F-Q2M/)).not.toBeInTheDocument()
    expect(screen.queryByText('Request rejected')).not.toBeInTheDocument()
    expect(screen.getByText('studio-mbp').closest('[data-member]')).not.toBeNull()
  })

  it('rejected: joining clears without the member', () => {
    renderWith(status([], { joining: joining() }))
    act(() => useOrbital.getState().setRemote(status([])))
    expect(screen.getByText('Request rejected')).toBeInTheDocument()
  })

  /** A joinGroup answer the test lands by hand, after the statuses the server publishes first. */
  function deferredJoin() {
    let land: (a: Awaited<ReturnType<typeof api.joinGroup>>) => void = () => {}
    vi.mocked(api.joinGroup).mockImplementationOnce(() => new Promise((resolve) => { land = resolve }))
    return async (a: Awaited<ReturnType<typeof api.joinGroup>>) => {
      await act(async () => { land(a) })
    }
  }

  function publish(remote: RemoteStatus) {
    act(() => useOrbital.getState().setRemote(remote))
  }

  it('a redeem the relay refuses: the joining the server published and cleared is no outcome, and the field keeps the code', async () => {
    renderWith(status([]))
    const land = deferredJoin()
    const code = codeFor()
    await paste(code)
    publish(status([], { joining: joining() }))
    expect(screen.queryByText(/^Type /)).not.toBeInTheDocument()
    publish(status([]))
    await land({ ok: false, error: 'peer_offline', expiresAt: T0 + 80_000 })
    expect(screen.queryByText('Request rejected')).not.toBeInTheDocument()
    expect(screen.getByText('studio-mbp is offline')).toBeInTheDocument()
    expect(screen.getByLabelText<HTMLInputElement>("Another device's code").value).toBe(code)
  })

  it('Try again that gets through shows the joining card, under the same key as before', async () => {
    renderWith(status([]))
    let land = deferredJoin()
    await paste(codeFor())
    publish(status([], { joining: joining() }))
    publish(status([]))
    await land({ ok: false, error: 'peer_offline', expiresAt: T0 + 80_000 })

    land = deferredJoin()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    publish(status([], { joining: joining() }))
    await land({ ok: true, device: PEER, name: 'studio-mbp', code: 'K7F-Q2M' })
    expect(screen.getByText('Type K7F-Q2M on studio-mbp')).toBeInTheDocument()
  })

  it('Cancel, then the same code again, shows the joining card again', async () => {
    renderWith(status([], { joining: joining() }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settle()
    publish(status([]))
    expect(screen.queryByText(/^Type /)).not.toBeInTheDocument()

    const land = deferredJoin()
    await paste(codeFor())
    publish(status([], { joining: joining() }))
    await land({ ok: true, device: PEER, name: 'studio-mbp', code: 'K7F-Q2M' })
    expect(screen.getByText('Type K7F-Q2M on studio-mbp')).toBeInTheDocument()
  })

  it('Use <relay> commits once: reopening Change relay does not commit it again', async () => {
    renderWith(status([]))
    await paste(codeFor({ relay: 'https://relay.lab.internal' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use relay.lab.internal' }))
    })
    expect(patchAndSet).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change relay' }))
    })
    expect(patchAndSet).toHaveBeenCalledTimes(1)
  })

  it('Use <relay> over a draft typed in the Relay field saves the proposal only', async () => {
    // userEvent's own waits want the real clock; nothing here counts down.
    vi.useRealTimers()
    const user = userEvent.setup()
    renderWith(status([]))
    await paste(codeFor({ relay: 'https://relay.lab.internal', expiresAt: Date.now() + 120_000 }))
    await user.click(screen.getByRole('button', { name: 'Change relay' }))
    const relay = screen.getByLabelText<HTMLInputElement>('Relay URL')
    await user.clear(relay)
    await user.type(relay, 'https://draft.test')
    await user.click(screen.getByRole('button', { name: 'Use relay.lab.internal' }))
    await user.click(document.body)
    expect(patchAndSet).toHaveBeenCalledTimes(1)
    expect(patchAndSet).toHaveBeenCalledWith({ remote_relay_url: 'https://relay.lab.internal' })
  })

  it('Use <relay> whose save failed saves again when the same URL is blurred', async () => {
    vi.useRealTimers()
    const user = userEvent.setup()
    patchAndSet.mockResolvedValueOnce(false)
    renderWith(status([]))
    await paste(codeFor({ relay: 'https://relay.lab.internal', expiresAt: Date.now() + 120_000 }))
    await user.click(screen.getByRole('button', { name: 'Use relay.lab.internal' }))
    expect(patchAndSet).toHaveBeenCalledTimes(1)
    const relay = screen.getByLabelText<HTMLInputElement>('Relay URL')
    expect(relay.value).toBe('https://relay.lab.internal')
    await user.click(relay)
    await user.click(document.body)
    expect(patchAndSet).toHaveBeenCalledTimes(2)
    expect(patchAndSet).toHaveBeenLastCalledWith({ remote_relay_url: 'https://relay.lab.internal' })
  })

  it('another relay while this device has none says so', async () => {
    renderWith(status([], { relayUrl: '' }))
    await paste(codeFor({ relay: 'https://relay.lab.internal' }))
    expect(screen.getByText(/this device has no relay yet\./)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use relay.lab.internal' })).toBeInTheDocument()
  })

  it('card C without the code\'s expiry still ages its check', async () => {
    vi.mocked(api.joinGroup).mockResolvedValue({ ok: false, error: 'peer_offline' })
    renderWith(status([]))
    await paste(codeFor({ expiresAt: undefined }))
    expect(screen.getByText(/^Checked just now\. Try again once studio-mbp is awake\./)).toBeInTheDocument()
    tick(2 * 60_000)
    expect(screen.getByText(/^Checked 2m ago\./)).toBeInTheDocument()
  })

  it('a join run out and lingering in the status never comes back over a later refusal', async () => {
    renderWith(status([], { joining: joining() }))
    tick(60_000)
    fireEvent.click(screen.getByRole('button', { name: 'Paste a new code' }))
    // The server publishes nothing for this refusal: the store still holds the old join.
    vi.mocked(api.joinGroup).mockResolvedValue({ ok: false, error: 'already_paired' })
    await paste(codeFor({ name: 'air-m3', expiresAt: T0 + 180_000 }))
    expect(screen.getByText('This device is already paired with air-m3.')).toBeInTheDocument()
    expect(screen.queryByText(/^Type /)).not.toBeInTheDocument()
    tick(5_000)
    expect(screen.queryByText('Code expired')).not.toBeInTheDocument()
    // Any later status drops the run-out join: still no card for it.
    publish(status([]))
    expect(screen.queryByText('Code expired')).not.toBeInTheDocument()
    expect(screen.getByText('This device is already paired with air-m3.')).toBeInTheDocument()
  })

  it('the countdown reaching zero first turns the card to expired, and the status clearing later keeps it', () => {
    renderWith(status([], { joining: joining() }))
    tick(60_000)
    expect(screen.getByText('Code expired')).toBeInTheDocument()
    act(() => useOrbital.getState().setRemote(status([])))
    expect(screen.getByText('Code expired')).toBeInTheDocument()
    expect(screen.queryByText('Request rejected')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Paste a new code' }))
    expect(screen.queryByText('Code expired')).not.toBeInTheDocument()
  })
})
