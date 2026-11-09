import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef } from 'react'
import { Button } from './Button'
import { FloatingTooltip, Tooltip } from './Tooltip'

/** Focus the first trigger as the story mounts: focus opens a tooltip with no delay. */
const openOnMount: Story['play'] = ({ canvasElement }) => {
  canvasElement.querySelector<HTMLElement>('button, [tabindex]')?.focus()
}

const meta = {
  title: 'UI/Tooltip',
  component: Tooltip,
  args: {
    variant: 'card',
    title: 'acceptEdits',
    description: 'Claude edits files without asking; commands still wait for you.',
    align: 'left',
    side: 'below',
    delayMs: 0,
    anchor: 'trigger',
    suppressed: false,
    children: <Button variant="pill">Accept edits</Button>,
  },
  render: (args) => (
    <div className="h-[200px]">
      <Tooltip {...args} />
    </div>
  ),
} satisfies Meta<typeof Tooltip>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** `card`: the mono name over one sentence. */
export const Open: Story = { play: openOnMount }

/** The keymap's binding printed muted after the title. */
export const WithShortcut: Story = {
  args: {
    title: 'End session',
    description: 'Stops the CLI and moves the session to ENDED.',
    shortcut: 'session.end',
    children: <Button variant="ghost">End</Button>,
  },
  play: openOnMount,
}

/** `name`: the one-line bubble for a name that did not fit its row. */
export const Name: Story = {
  render: () => (
    <div className="h-[200px]">
      <Tooltip variant="name" title="feature/relay-handshake-v3-with-backoff-and-reconnect">
        <span tabIndex={0} className="block w-40 truncate font-mono fs-11 text-ink-900/60">
          feature/relay-handshake-v3-with-backoff-and-reconnect
        </span>
      </Tooltip>
    </div>
  ),
  play: openOnMount,
}

/** `side: 'above'` for a trigger at the foot of the window; `align: 'right'` for one at a panel's right end. */
export const AboveRight: Story = {
  args: { side: 'above', align: 'right' },
  render: (args) => (
    <div className="flex h-[200px] items-end justify-end">
      <Tooltip {...args} />
    </div>
  ),
  play: openOnMount,
}

/** `panel` with the `branch` shell: rows the caller lays out. */
export const PanelBranch: Story = {
  render: () => (
    <div className="h-[220px]">
      <Tooltip
        variant="panel"
        content={
          <>
            <span className="font-mono fs-11 text-ink-100">PR #176 · open</span>
            <span className="fs-11.5 leading-[1.45] text-ink-900/80">Release: desktop 0.46.0, phone 0.23.0</span>
            <span className="font-mono fs-10.5 text-ink-900/55">+412 −87 · 23 files</span>
          </>
        }
      >
        <Button variant="pill">#176</Button>
      </Tooltip>
    </div>
  ),
  play: openOnMount,
}

/** `panel` with the `flyout` shell: the device pill's RUNS ON card. */
export const PanelFlyout: Story = {
  render: () => (
    <div className="h-[220px]">
      <Tooltip
        variant="panel"
        shell="flyout"
        widthPx={240}
        content={
          <>
            <span className="font-mono fs-9.5 tracking-[0.18em] text-ink-900/55">RUNS ON</span>
            <span className="fs-13 font-semibold text-ink-100">MacBook Pro</span>
            <span className="font-mono fs-10.5 text-ink-900/55">macOS 27.2 · Orbital 0.46.0</span>
          </>
        }
      >
        <Button variant="pill">This Mac</Button>
      </Tooltip>
    </div>
  ),
  play: openOnMount,
}

/** `panel` clamped inside a box: the bubble's right edge never leaves it. */
export const PanelClamped: Story = {
  render: () => <ClampedDemo />,
  play: openOnMount,
}

function ClampedDemo() {
  const box = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={box} className="flex h-[220px] w-[360px] items-start justify-end border border-dashed border-line/20 p-3">
      <Tooltip
        variant="panel"
        clampWithin={() => box.current}
        content={<span className="fs-11.5 text-ink-900/80">+412 −87 across 23 files since main.</span>}
      >
        <Button variant="pill">+412 −87</Button>
      </Tooltip>
    </div>
  )
}

/** `FloatingTooltip`: the card hung above a rectangle another renderer owns; with `tail`, a speech bubble. */
export const Floating: Story = {
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div className="relative h-[300px]">
      <span className="absolute top-[140px] left-[60px] rounded-[3px] bg-line/14 px-1 font-mono fs-12 text-ink-100">
        /orbital-code-review
      </span>
      <FloatingTooltip
        title="/orbital-code-review"
        aside="skill"
        description="Review a change in the Orbital repo by fanning it out to focused review agents."
        rect={new DOMRect(60, 140, 150, 18)}
      />
      <span className="absolute top-[240px] left-[520px] font-mono fs-12 text-ink-900/60">sloth</span>
      <FloatingTooltip title="Sloth" description="Slow is smooth, smooth is fast." rect={new DOMRect(520, 240, 40, 18)} tail />
    </div>
  ),
}
