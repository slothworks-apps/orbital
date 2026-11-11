import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { Toggle } from '../ui/Checkbox'
import { Segmented } from '../ui/Segmented'
import {
  GroupLine,
  Row,
  RowTitle,
  ScopeLabel,
  ScopeSection,
  SectionLabel,
  SharingProvider,
  type SettingsSharing,
} from './settingsRows'

const SHARING: SettingsSharing = {
  shown: true,
  names: ['Studio Mac', 'MacBook Air', 'build-box'],
  old: [{ id: 'old-mac', name: 'Office iMac' }],
  openDevices: fn(),
}

/** A run of rows as one Settings tab draws them, in the content column. */
function Section({ sharing }: { sharing?: SettingsSharing }) {
  const rows = (
    <div className="w-[680px]">
      <GroupLine />
      <ScopeSection keys={['default_permission_mode', 'confirm_before_clear', 'text_scale']}>
        <SectionLabel first>SESSIONS</SectionLabel>
        <Row title="Confirm before clearing" setting="confirm_before_clear" desc="/clear asks first, so a conversation is not lost to a stray keystroke.">
          <Toggle aria-label="Confirm before clearing" checked onChange={() => {}} />
        </Row>
        <Row title="Text size" setting="text_scale" desc="The size of the app's text on this Mac.">
          <Segmented
            label="Text size"
            value="m"
            onChange={() => {}}
            options={[
              { value: 's', label: 'Small' },
              { value: 'm', label: 'Default' },
              { value: 'l', label: 'Large' },
            ]}
          />
        </Row>
        <Row
          title="Notify when a session ends"
          setting="notify_session_ended"
          dimmed
          desc="Nothing to set while every notification is off."
        >
          <Toggle aria-label="Notify when a session ends" checked={false} disabled onChange={() => {}} />
        </Row>
      </ScopeSection>
      <ScopeSection scope="shared">
        <SectionLabel aside="Finished features, each off until you turn it on.">LABS</SectionLabel>
        <Row labs title="Limit suns" setting="limit_suns_enabled" desc="Your plan's usage windows as suns at the map's edge.">
          <Toggle aria-label="Limit suns" checked={false} onChange={() => {}} />
        </Row>
      </ScopeSection>
    </div>
  )
  return sharing ? <SharingProvider value={sharing}>{rows}</SharingProvider> : rows
}

const meta = {
  title: 'Panels/settingsRows',
  component: Section,
  args: {},
} satisfies Meta<typeof Section>
export default meta

type Story = StoryObj<typeof meta>

/** Alone: no scope marked, Settings as it was before groups shared anything. */
export const Alone: Story = {}

/** In a group: the group line, section scopes, THIS MAC ONLY on a per-device row of a mixed section. */
export const SharedInAGroup: Story = { args: { sharing: SHARING } }

/** The pieces: every scope label, and a row title with and without its mark. */
export const Pieces: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex gap-6">
        <ScopeLabel scope="shared" />
        <ScopeLabel scope="device" />
        <ScopeLabel scope="mixed" />
        <ScopeLabel scope="group" />
      </div>
      <RowTitle title="Text size" mark={false} />
      <RowTitle title="Text size" mark />
    </div>
  ),
}
