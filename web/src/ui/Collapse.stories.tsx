import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState, type ComponentProps } from 'react'
import { Button } from './Button'
import { Collapse } from './Collapse'

function Detail() {
  return (
    <div className="flex flex-col gap-1 rounded-[8px] border border-line/12 px-4 py-3 fs-13 text-ink-400/90">
      <span className="font-mono fs-10 tracking-[0.18em] text-ink-900/60">DETAIL</span>
      Opus · accept edits · ~/Projects/slothworks/orbital
    </div>
  )
}

type CollapseProps = ComponentProps<typeof Collapse>

/** A toggle above, a row below that glides as the block opens and closes. */
function CollapseDemo(props: CollapseProps) {
  const [open, setOpen] = useState(props.open)
  return (
    <div className="flex w-[420px] flex-col gap-2">
      <div>
        <Button variant="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Open'}
        </Button>
      </div>
      <span className="fs-13 text-ink-100">Fix the relay handshake</span>
      <Collapse {...props} open={open} />
      <span className="fs-13 text-ink-900/60">Changelog for 0.46.0 — the row below</span>
    </div>
  )
}

const meta = {
  title: 'UI/Collapse',
  component: Collapse,
  args: {
    open: true,
    appear: false,
    stagger: false,
    keepMounted: false,
    pull: 0,
    unclip: false,
    children: <Detail />,
  },
  render: (args) => <CollapseDemo {...args} />,
} satisfies Meta<typeof Collapse>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** Closed: nothing mounted, no room taken. */
export const Closed: Story = { args: { open: false } }

/** `stagger`: fade, then height on close; height, then fade on open. */
export const Stagger: Story = { args: { stagger: true } }

/** `appear`: animates the first mount too. */
export const Appear: Story = { args: { appear: true } }

/** `keepMounted` with `pull`: hidden and inert when closed, a parent's gap closed with it. */
export const KeepMountedPull: Story = { args: { keepMounted: true, pull: -8, open: false } }

/** `unclip`: once settled open, a focus ring at its edge is no longer cut. */
export const Unclip: Story = { args: { unclip: true } }

/** A clock of its own in place of the shared one. */
export const CustomTiming: Story = { args: { stagger: true, timing: { heightMs: 600, fadeMs: 300, ease: 'ease-in-out' } } }
