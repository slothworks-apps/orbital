import type { Meta, StoryObj } from '@storybook/react-vite'
import { BILLING, DOCS, MODELS } from '../../../site/demo/fake/fixtures'
import { useOrbital } from '../store/store'
import { ModelSwitcher } from './ModelSwitcher'

/** The session in the store and on screen, where a switch writes its new model. */
function seedStore(): () => void {
  const before = useOrbital.getState()
  useOrbital.setState({
    sessions: { [BILLING.id]: BILLING, [DOCS.id]: DOCS },
    ui: { ...before.ui, selectedId: BILLING.id },
  })
  return () => useOrbital.setState(before, true)
}

/** Opens the listbox as the story mounts. */
const openOnMount: Story['play'] = ({ canvasElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.click()
}

/** Opens the listbox and picks the other model: the confirm comes up. */
const pickSonnet: Story['play'] = async ({ canvasElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 50))
  canvasElement.querySelector<HTMLButtonElement>('[role="option"][aria-label="Sonnet 5"]')?.click()
}

const meta = {
  title: 'Panels/ModelSwitcher',
  component: ModelSwitcher,
  beforeEach: seedStore,
  args: { session: BILLING, models: MODELS, defaultValue: 'sonnet', hidden: false },
  // The right end of the detail header's chip row; the listbox hangs to the left.
  render: (args) => (
    <div className="flex justify-end" style={{ width: 450, height: 360 }}>
      <div className="flex h-fit items-center gap-2">
        <ModelSwitcher {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof ModelSwitcher>
export default meta

type Story = StoryObj<typeof meta>

/** The model chip at rest. */
export const Closed: Story = {}

/** The catalogue, the current model marked and the Settings default named. */
export const Open: Story = { play: openOnMount }

/** A pick asks first: the next turn re-reads the conversation on the other model. */
export const ConfirmSwitch: Story = { parameters: { layout: 'fullscreen' }, play: pickSonnet }

/** A session Orbital does not own: an inert chip with the reason as its tooltip. */
export const Disabled: Story = { args: { disabledReason: 'Live in a terminal — Orbital does not own this session' } }

/** The model list could not be read: an inert chip. */
export const EmptyCatalog: Story = { args: { models: [] } }
