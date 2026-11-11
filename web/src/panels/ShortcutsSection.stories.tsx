import type { Meta, StoryObj } from '@storybook/react-vite'
import { userEvent } from 'storybook/test'
import { ShortcutsSection } from './ShortcutsSection'

/** Types into the filter, which the section focuses as it opens. */
const filter = (query: string): Story['play'] => async ({ canvasElement }) => {
  const input = canvasElement.querySelector<HTMLInputElement>('input[aria-label="Filter shortcuts"]')
  if (input) await userEvent.type(input, query)
}

const meta = {
  title: 'Panels/ShortcutsSection',
  component: ShortcutsSection,
  parameters: { layout: 'fullscreen' },
  // Settings' content pane: the filter pinned, the list scrolling under it.
  render: () => (
    <div className="flex flex-col" style={{ width: 824, height: 760 }}>
      <ShortcutsSection />
    </div>
  ),
} satisfies Meta<typeof ShortcutsSection>
export default meta

type Story = StoryObj<typeof meta>

/** The live keymap, grouped by where each key works. */
export const Keymap: Story = {}

/** Filtered by an action word: the count of what is left. */
export const Filtered: Story = { play: filter('session') }

/** Nothing bound to the query. */
export const NoMatch: Story = { play: filter('zzz') }
