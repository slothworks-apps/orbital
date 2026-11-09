import type { Meta, StoryObj } from '@storybook/react-vite'
import { UPDATE_CHANNEL_KEY } from '@orbital/shared/updateChannel'
import { fn } from 'storybook/test'
import { DEMO_EPOCH } from '../../../site/demo/fake/fixtures'
import { api } from '../lib/api'
import { AUTO_DOWNLOAD_KEY } from '../lib/appUpdate'
import type { UpdateBridge, UpdateCheckAnswer, UpdateState } from '../lib/desktop'
import { useAppUpdate } from '../store/appUpdate'
import { useOrbital } from '../store/store'
import { UpdatesSection } from './UpdatesSection'

/** The desktop's update bridge, as main answers it; a browser has none, and Settings lists no Updates there. */
function bridge(answer: UpdateCheckAnswer): UpdateBridge {
  return {
    onUpdateState: () => {},
    getUpdateState: () => new Promise(() => {}),
    updateAction: fn(),
    checkForUpdates: () => Promise.resolve(answer),
  }
}

const CHECKED: UpdateState = { phase: 'none', checkedAt: DEMO_EPOCH - 2 * 60 * 60_000, latestRegular: null }

/**
 * The update state main last pushed, the settings the section reads, and
 * when experimental updates were turned on — the catalogue's fake server
 * stamps no setting.
 */
function seed(state: UpdateState, settings: Record<string, string> = {}, answer: UpdateCheckAnswer = { kind: 'up-to-date' }): () => () => void {
  return () => {
    const beforeUpdate = useAppUpdate.getState()
    const beforeStore = useOrbital.getState()
    const realStamp = api.getSettingStamp
    api.getSettingStamp = () => Promise.resolve({ value: settings[UPDATE_CHANNEL_KEY] ?? null, at: DEMO_EPOCH - 3 * 24 * 60 * 60_000, origin: null })
    useAppUpdate.setState({ source: bridge(answer), state, shown: state })
    useOrbital.setState({ settings: { ...beforeStore.settings, ...settings } })
    return () => {
      useAppUpdate.setState(beforeUpdate, true)
      useOrbital.setState(beforeStore, true)
      api.getSettingStamp = realStamp
    }
  }
}

const meta = {
  title: 'Panels/UpdatesSection',
  component: UpdatesSection,
  parameters: { layout: 'fullscreen' },
  beforeEach: seed(CHECKED),
  args: { patchAndSet: () => Promise.resolve(true) },
  // Settings' content pane.
  render: (args) => (
    <div className="flex flex-col" style={{ width: 824, height: 640 }}>
      <UpdatesSection {...args} />
    </div>
  ),
} satisfies Meta<typeof UpdatesSection>
export default meta

type Story = StoryObj<typeof meta>

/** Up to date, last checked two hours ago; downloads ask first. */
export const UpToDate: Story = {}

/** Check now pressed and a version found: it downloads by itself, the map asks when it is ready. */
export const Found: Story = {
  beforeEach: seed(CHECKED, { [AUTO_DOWNLOAD_KEY]: 'true' }, { kind: 'found', version: '0.47.0', outcome: 'downloading' }),
  play: ({ canvasElement }) => {
    ;[...canvasElement.querySelectorAll('button')].find((b) => b.textContent === 'Check now')?.click()
  },
}

/** A downloaded update waits for the working sessions: its line and Cancel. */
export const WaitingForSessions: Story = {
  beforeEach: seed({ phase: 'waiting', version: '0.47.0', workingCount: 2, checkedAt: DEMO_EPOCH - 60_000 }),
}

/** Experimental updates on, with who turned them on and when. */
export const Experimental: Story = { beforeEach: seed(CHECKED, { [UPDATE_CHANNEL_KEY]: 'experimental' }) }

/** Turning experimental updates on asks first. */
export const ExperimentalConfirm: Story = {
  play: ({ canvasElement }) => canvasElement.querySelector<HTMLElement>('[aria-label="Experimental updates"]')?.click(),
}
