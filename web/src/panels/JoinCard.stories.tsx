import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn, screen, userEvent } from 'storybook/test'
import { toBase64Url } from '@orbital/shared/remote/keys'
import { encodePairingCode } from '@orbital/shared/remote/relayApi'
import { api } from '../lib/api'
import type { JoinAnswer, RemoteStatus } from '../lib/types'
import { JoinArea } from './JoinCard'

const RELAY = 'https://relay.example.com'
/** A made-up device id: any 32 bytes, canonically encoded. */
const PEER = toBase64Url(new Uint8Array(32).fill(7))

/** This Mac alone on the relay, online, with nothing under way. */
const ALONE: RemoteStatus = {
  enabled: true,
  relay: 'online',
  relayTooOld: null,
  relayAttempts: 0,
  relayUrl: RELAY,
  macId: 'this-mac',
  macName: 'studio',
  devices: [],
  pendingPair: null,
  pairing: null,
  joining: null,
  error: null,
  group: { members: [], relayLocked: false, primary: null, isPrimary: false, ended: null, pendingJoin: null, joinExpired: null },
}

/** Another device's code, as its Devices section shows it. */
function codeFor(patch: Record<string, unknown> = {}): string {
  return encodePairingCode(
    JSON.stringify({
      v: 1, relay: RELAY, mac: PEER, name: 'imac-home', token: 'tok', secret: toBase64Url(new Uint8Array(16)),
      kind: 'desktop', expiresAt: Date.now() + 90_000, ...patch,
    }),
  )
}

/** The server's answer to Join. */
function joinAnswers(answer: JoinAnswer): () => () => void {
  return () => {
    const real = api.joinGroup
    api.joinGroup = () => Promise.resolve(answer)
    return () => {
      api.joinGroup = real
    }
  }
}

/** Pastes `code` and presses Join. */
function pasteAndJoin(code: () => string) {
  return async () => {
    await userEvent.type(await screen.findByLabelText("Another device's code"), code(), { delay: null })
    await userEvent.click(screen.getByRole('button', { name: 'Join' }))
  }
}

const meta = {
  title: 'Panels/JoinCard',
  component: JoinArea,
  args: {
    remote: ALONE,
    onUseRelay: fn(),
    // The box Settings → Devices draws around the field while nothing is under way.
    idle: (field) => <div className="flex flex-col gap-3.5 rounded-[12px] border border-line/12 bg-space/55 p-4">{field}</div>,
  },
  render: (args) => (
    <div className="w-[460px]">
      <JoinArea {...args} />
    </div>
  ),
} satisfies Meta<typeof JoinArea>
export default meta

type Story = StoryObj<typeof meta>

/** Nothing under way: the field and Join, in Settings' box. */
export const Idle: Story = {}

/** Text that is no code: one quiet line under the field. */
export const NotACode: Story = { play: pasteAndJoin(() => 'hello there') }

/** A code from another relay: the field stays, the card says both need the same one. */
export const OtherRelay: Story = { play: pasteAndJoin(() => codeFor({ relay: 'https://relay.other.example' })) }

/** The other device is asleep: Try again while its code is still good. */
export const PeerOffline: Story = {
  beforeEach: joinAnswers({ ok: false, error: 'peer_offline', expiresAt: Date.now() + 80_000 }),
  play: pasteAndJoin(() => codeFor()),
}

/** A code that already ran out: the expired card with Start over. */
export const Expired: Story = { play: pasteAndJoin(() => codeFor({ expiresAt: Date.now() - 1_000 })) }

/** The join under way: the six characters to type on the other device. */
export const Joining: Story = {
  args: {
    remote: {
      ...ALONE,
      joining: {
        device: PEER, name: 'imac-home', kind: 'desktop', code: 'K7F-Q2M', expiresAt: Date.now() + 10 * 60_000,
        manager: { by: 'there', newGroup: true },
      },
    },
  },
}

/** Paired, the primary's first roster not come yet. */
export const WaitingForGroup: Story = {
  args: {
    remote: {
      ...ALONE,
      devices: [
        { id: PEER, name: 'imac-home', platform: 'macos', kind: 'desktop', pairedAt: Date.now(), lastSeenAt: Date.now(), online: true, needsUpdate: null },
      ],
      group: { ...ALONE.group, pendingJoin: { primary: PEER, expiresAt: Date.now() + 10 * 60_000 } },
    },
  },
}

/** The primary never sent the group before the code ran out. */
export const NeverSent: Story = {
  args: { remote: { ...ALONE, group: { ...ALONE.group, joinExpired: { id: PEER, name: 'imac-home' } } } },
}
