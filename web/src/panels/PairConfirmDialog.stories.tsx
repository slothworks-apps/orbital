import type { Meta, StoryObj } from '@storybook/react-vite'
import { screen, userEvent } from 'storybook/test'
import { api } from '../lib/api'
import type { RemoteStatus } from '../lib/types'
import { useOrbital } from '../store/store'
import { PairConfirmDialog } from './PairConfirmDialog'

type PendingPair = NonNullable<RemoteStatus['pendingPair']>

const PHONE: PendingPair = { phone: 'p1', name: 'Pixel 8', platform: 'android', kind: 'phone', attemptsLeft: 3, manager: null }
const DESKTOP: PendingPair = { phone: 'p2', name: 'imac-home', platform: 'macos', kind: 'desktop', attemptsLeft: 3, manager: null }
const HEADLESS: PendingPair = { phone: 'p3', name: 'build-box', platform: 'linux', kind: 'headless', attemptsLeft: 3, manager: null }

/** The Mac's remote status with a request waiting; the code's clock far from running out. */
function remote(pendingPair: PendingPair): RemoteStatus {
  return {
    enabled: true,
    relay: 'online',
    relayTooOld: null,
    relayAttempts: 0,
    relayUrl: 'https://relay.example.com',
    macId: 'mac',
    macName: 'studio',
    devices: [],
    pendingPair,
    pairing: { expiresAt: Date.now() + 10 * 60_000 },
    joining: null,
    error: null,
    group: { members: [], relayLocked: false, primary: null, isPrimary: false, ended: null, pendingJoin: null, joinExpired: null },
  }
}

/** The dialog opens on the status's `pendingPair`, wherever the user is. */
function request(pending: PendingPair): () => () => void {
  return () => {
    const before = useOrbital.getState()
    useOrbital.setState({ remote: remote(pending) })
    return () => useOrbital.setState(before, true)
  }
}

/** The server's answer to Accept, standing in for the relay. */
function answers(result: Awaited<ReturnType<typeof api.confirmPairing>>): () => () => void {
  return () => {
    const real = api.confirmPairing
    api.confirmPairing = () => Promise.resolve(result)
    return () => {
      api.confirmPairing = real
    }
  }
}

/** Types a whole code and accepts it. */
async function typeAndAccept() {
  await userEvent.type(await screen.findByLabelText('Pairing code'), 'K7FQ2M')
  await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
}

const meta = {
  title: 'Panels/PairConfirmDialog',
  component: PairConfirmDialog,
  parameters: { layout: 'fullscreen' },
  beforeEach: request(PHONE),
  render: () => (
    <div className="min-h-screen">
      <PairConfirmDialog />
    </div>
  ),
} satisfies Meta<typeof PairConfirmDialog>
export default meta

type Story = StoryObj<typeof meta>

/** A phone asks to join: its kind three times, the code boxes empty, Accept dim. */
export const Phone: Story = {}

/** A desktop: the tile and the sentence say DESKTOP and macOS. */
export const Desktop: Story = { beforeEach: request(DESKTOP) }

/** A headless server: never to be mistaken for a phone. */
export const Headless: Story = { beforeEach: request(HEADLESS) }

/** The request founds a new group managed here: the line that says the role is permanent. */
export const NewGroup: Story = {
  beforeEach: request({ ...PHONE, manager: { by: 'here', newGroup: true } }),
}

/** A wrong code: the boxes clear and one quiet line counts what is left. */
export const WrongCode: Story = {
  beforeEach: answers({ error: 'code_mismatch', attemptsLeft: 2 }),
  play: typeAndAccept,
}

/** The relay did not answer: the line under the boxes says so. */
export const RelayFailed: Story = {
  beforeEach: answers({ error: 'relay_error' }),
  play: typeAndAccept,
}

/** Accepted: the joined screen with its checkmark and Done. */
export const Joined: Story = {
  beforeEach: answers({ ok: true }),
  play: typeAndAccept,
}

/** The group had no room: the dimmed tile, the fact and the way to Devices. */
export const GroupFull: Story = {
  beforeEach: answers({ error: 'group_full' }),
  play: typeAndAccept,
}
