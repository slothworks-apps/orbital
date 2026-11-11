import type { Meta, StoryObj } from '@storybook/react-vite'
import { Keycap, type KeycapProps } from './Keycap'

const meta = {
  title: 'UI/Keycap',
  component: Keycap,
  args: { chord: 'meta+shift+n', muted: false, gesture: false },
} satisfies Meta<typeof Keycap>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const CAPS: { name: string; props: KeycapProps }[] = [
  { name: "chord 'meta+n'", props: { chord: 'meta+n' } },
  { name: "chord 'meta+shift+e'", props: { chord: 'meta+shift+e' } },
  { name: "chord 'meta+Digit2'", props: { chord: 'meta+Digit2' } },
  { name: "chord 'meta+ArrowUp'", props: { chord: 'meta+ArrowUp' } },
  { name: "chord 'ctrl+shift+Tab'", props: { chord: 'ctrl+shift+Tab' } },
  { name: "chord 'Enter'", props: { chord: 'Enter' } },
  { name: "display '1–9'", props: { display: '1–9' } },
  { name: "display ['⌘', '⏎']", props: { display: ['⌘', '⏎'] } },
  { name: 'muted', props: { chord: 'alt+Enter', muted: true } },
  { name: 'gesture', props: { display: '⌥-click', gesture: true } },
]

export const Gallery: Story = {
  render: () => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] items-start gap-4">
      {CAPS.map(({ name, props }) => (
        <div key={name} className="flex flex-col items-start gap-1.5">
          <Keycap {...props} />
          <span className="font-mono fs-10.5 text-ink-900/60">{name}</span>
        </div>
      ))}
    </div>
  ),
}
