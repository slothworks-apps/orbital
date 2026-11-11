import type { Meta, StoryObj } from '@storybook/react-vite'
import { BrowserCaption } from './BrowserCaption'

/** Hovers the caption as the story mounts; the card rises after its beat. */
const hoverOnMount: Story['play'] = ({ canvasElement }) => {
  canvasElement.querySelector('[data-sent-browser]')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
}

const meta = {
  title: 'Panels/BrowserCaption',
  component: BrowserCaption,
  args: {
    kind: 'selection',
    title: 'Webhooks — Billing API reference',
    url: 'https://docs.example.com/billing/webhooks#retries',
    chars: 412,
  },
  // Under a sent bubble, right-aligned in the transcript column.
  render: (args) => (
    <div className="flex w-[450px] flex-col items-end pt-[120px]">
      <BrowserCaption {...args} />
    </div>
  ),
} satisfies Meta<typeof BrowserCaption>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** A selection, a screenshot, a page with no title, and one that cannot be opened (no press). */
export const Kinds: Story = {
  render: (args) => (
    <div className="flex w-[450px] flex-col items-end gap-3">
      <BrowserCaption {...args} />
      <BrowserCaption {...args} kind="screenshot" chars={undefined} />
      <BrowserCaption {...args} title="" chars={1} />
      <BrowserCaption {...args} title="Local notes" url="file:///Users/demo/notes.html" />
      <BrowserCaption
        {...args}
        title="A page title long enough that the caption has to cut it at the bubble's width"
      />
    </div>
  ),
}

/** The hover card: the whole title, the URL, the length and where a press goes. */
export const Hovered: Story = { play: hoverOnMount }
