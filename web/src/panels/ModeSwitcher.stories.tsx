import type { Meta, StoryObj } from '@storybook/react-vite'
import { BILLING } from '../../../site/demo/fake/fixtures'
import { useOrbital } from '../store/store'
import { ModeSwitcher } from './ModeSwitcher'

/** The session in the store, where a pick writes its new mode. */
function seedStore(): () => void {
  const before = useOrbital.getState()
  useOrbital.setState({ sessions: { [BILLING.id]: BILLING } })
  return () => useOrbital.setState(before, true)
}

/** Opens the listbox as the story mounts. */
const openOnMount: Story['play'] = ({ canvasElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.click()
}

const meta = {
  title: 'Panels/ModeSwitcher',
  component: ModeSwitcher,
  beforeEach: seedStore,
  args: { session: BILLING, disabled: false },
  // The right end of the detail header's chip row; the listbox hangs to the left.
  render: (args) => (
    <div className="flex justify-end" style={{ width: 450, height: 420 }}>
      <div className="flex h-fit items-center gap-2">
        <ModeSwitcher {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof ModeSwitcher>
export default meta

type Story = StoryObj<typeof meta>

/** The dot box at rest: accept edits. */
export const Closed: Story = {}

/** The four modes, the current one marked. */
export const Open: Story = { play: openOnMount }

/** Plan mode current. */
export const PlanMode: Story = { args: { session: { ...BILLING, permissionMode: 'plan' } }, play: openOnMount }

/** Bypass permissions current. */
export const Bypass: Story = { args: { session: { ...BILLING, permissionMode: 'bypassPermissions' } } }

/** A session Orbital cannot drive (live in a terminal, or on a device that cannot be reached): the readout alone. */
export const Disabled: Story = { args: { disabled: true } }
