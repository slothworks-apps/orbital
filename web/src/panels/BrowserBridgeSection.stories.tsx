import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import { api } from '../lib/api'
import { BROWSER_BRIDGE_SETTING, type BrowserStatus } from '../lib/browserBridge'
import { BrowserBridgeRows } from './BrowserBridgeSection'

const DAY = 24 * 60 * 60_000

const PAIRED: BrowserStatus = {
  enabled: true,
  port: 4848,
  codeExpiresAt: null,
  pairings: [
    { id: 'chrome', browser: 'Chrome', pairedAt: DEMO_EPOCH - 6 * DAY, connected: true, lastSeenAt: DEMO_EPOCH },
    { id: 'arc', browser: 'Arc', pairedAt: DEMO_EPOCH - 20 * DAY, connected: false, lastSeenAt: DEMO_EPOCH - DAY },
  ],
}

const NONE: BrowserStatus = { ...PAIRED, pairings: [] }

/** The bridge's status and a pairing code answered here; the catalogue's fake server has no bridge. */
function stubBridge(status: BrowserStatus): () => () => void {
  return () => {
    const realStatus = api.browserStatus
    const realCode = api.browserPairingCode
    api.browserStatus = () => Promise.resolve(status)
    api.browserPairingCode = () => Promise.resolve({ code: 'K7Q4M2', expiresAt: Date.now() + 5 * 60_000 })
    return () => {
      api.browserStatus = realStatus
      api.browserPairingCode = realCode
    }
  }
}

/** Holds the switch the rows write, as Settings' own `patchAndSet` does. */
function BrowserBridgeDemo({ enabled }: { enabled: boolean }) {
  const [settings, setSettings] = useState<Record<string, string>>({ [BROWSER_BRIDGE_SETTING]: enabled ? 'true' : 'false' })
  return (
    // Settings → Labs' content column.
    <div className="flex flex-col px-8" style={{ width: 824 }}>
      <BrowserBridgeRows
        settings={settings}
        patchAndSet={(patch) => {
          setSettings((s) => ({ ...s, ...patch }))
          return Promise.resolve(true)
        }}
      />
    </div>
  )
}

const meta = {
  title: 'Panels/BrowserBridgeSection',
  component: BrowserBridgeDemo,
  beforeEach: stubBridge(PAIRED),
  args: { enabled: true },
} satisfies Meta<typeof BrowserBridgeDemo>
export default meta

type Story = StoryObj<typeof meta>

/** On, two browsers paired — one connected, one last seen yesterday; the install steps folded. */
export const Paired: Story = {}

/** On, nothing paired yet: the steps open. */
export const NonePaired: Story = { beforeEach: stubBridge(NONE) }

/** Pair a browser pressed: the code panel in its place. */
export const PairingCode: Story = {
  play: async ({ canvasElement }) => {
    const pair = await new Promise<HTMLButtonElement>((resolve) => {
      const find = () => {
        const button = [...canvasElement.querySelectorAll('button')].find((b) => b.textContent === 'Pair a browser')
        if (button) resolve(button)
        else requestAnimationFrame(find)
      }
      find()
    })
    pair.click()
  },
}

/** Off: the switch alone. */
export const Off: Story = { args: { enabled: false } }
