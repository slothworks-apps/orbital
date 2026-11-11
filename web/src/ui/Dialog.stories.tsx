import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { fn } from 'storybook/test'
import { Button } from './Button'
import { Dialog, type DialogProps } from './Dialog'

const CLEAR_BODY = (
  <p className="fs-14 leading-[1.55] text-ink-400/90">
    The conversation in <span className="font-mono text-ink-100">Fix the relay handshake</span> starts over. Its
    transcript stays in the session history.
  </p>
)

const CONFIRM_FOOTER = (
  <>
    <Button variant="ghost">Cancel</Button>
    <Button variant="primary">Clear</Button>
  </>
)

function DialogDemo(props: DialogProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-h-screen p-6">
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Clear conversation…
      </Button>
      <Dialog
        {...props}
        open={open}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setOpen(false)}>
              Clear
            </Button>
          </>
        }
      />
    </div>
  )
}

const meta = {
  title: 'UI/Dialog',
  component: Dialog,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    title: 'Clear this conversation?',
    eyebrow: '/clear',
    size: 'md',
    tone: 'accent',
    variant: 'frame',
    bodyInset: 'form',
    eyebrowPulse: false,
    dropArmed: false,
    anchorTop: false,
    footerCaption: 'esc cancel · ↵ clear',
    footer: CONFIRM_FOOTER,
    children: CLEAR_BODY,
    onClose: fn(),
  },
  render: (args) => (
    <div className="min-h-screen">
      <Dialog {...args} />
    </div>
  ),
} satisfies Meta<typeof Dialog>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** Opened from a trigger, the way every caller holds it. */
export const WithTrigger: Story = {
  render: (args) => <DialogDemo {...args} />,
}

/** `sm`: the 440px stop confirm, framed in amber with the live-turn dot. */
export const StopConfirm: Story = {
  args: {
    size: 'sm',
    tone: 'warning',
    eyebrow: 'STOP',
    eyebrowPulse: true,
    title: 'Stop the turn in progress?',
    footerCaption: 'esc cancel',
    footer: (
      <>
        <Button variant="ghost">Keep going</Button>
        <Button variant="warning">Stop</Button>
      </>
    ),
    children: (
      <p className="fs-14 leading-[1.55] text-ink-400/90">
        Opus is still writing. What it has done so far stays in the transcript.
      </p>
    ),
  },
}

/** `lg`: the form dialog, with a ruled header and the esc keycap. */
export const Form: Story = {
  args: {
    size: 'lg',
    eyebrow: 'LAUNCH',
    title: 'New session',
    footerCaption: '⌘↵ launch',
    footer: (
      <>
        <Button variant="ghost">Cancel</Button>
        <Button variant="primary">Launch session</Button>
      </>
    ),
    children: (
      <div className="flex flex-col gap-4">
        {[
          ['PROJECT', '~/Projects/slothworks/orbital'],
          ['MODEL', 'Opus'],
          ['MODE', 'Accept edits'],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1.5">
            <span className="font-mono fs-10 tracking-[0.18em] text-ink-900/60">{label}</span>
            <span className="rounded-[8px] border border-line/14 px-3 py-2 fs-13 text-ink-100">{value}</span>
          </div>
        ))}
      </div>
    ),
  },
}

const ERRORS = [
  ['14:02', 'Relay refused the handshake: version 3 is too old'],
  ['13:47', 'Transcript line 812 could not be read'],
  ['11:20', 'Spawn failed: the project directory is gone'],
  ['09:05', 'Rate limit reached for Opus; retried after 40 s'],
]

/** `xl`: the error log, with a header read-out and a capped height. */
export const ErrorLog: Story = {
  args: {
    size: 'xl',
    eyebrow: 'ERRORS',
    title: 'Error log',
    headerMeta: '12 entries · 3 unseen cleared',
    maxHeight: 480,
    footerCaption: 'newest first',
    footer: <Button variant="ghost">Clear all</Button>,
    children: (
      <ul className="flex flex-col">
        {[...ERRORS, ...ERRORS, ...ERRORS].map(([time, line], i) => (
          <li key={i} className="flex gap-4 border-b border-line/8 py-2.5 fs-13 text-ink-400/90">
            <span className="font-mono fs-11 text-ink-900/55">{time}</span>
            {line}
          </li>
        ))}
      </ul>
    ),
  },
}

/** `2xl`: the two-column New session, with a control beside the esc keycap. */
export const TwoColumn: Story = {
  args: {
    size: '2xl',
    eyebrow: 'LAUNCH',
    title: 'New session',
    headerAction: <Button variant="pill">CLAUDE DIR · work</Button>,
    footerLead: <Button variant="dashed-link">+ Add image</Button>,
    footerCaption: '⌘↵ launch',
    footer: <Button variant="primary">Launch session</Button>,
    children: (
      <div className="grid grid-cols-2 gap-7">
        <div className="h-48 rounded-[10px] border border-line/12 p-4 fs-13 text-ink-900/60">
          Tighten the relay's reconnect backoff…
        </div>
        <div className="flex flex-col gap-2 fs-13 text-ink-400/90">
          <span>orbital</span>
          <span>slothworks-infra</span>
          <span>beam</span>
        </div>
      </div>
    ),
  },
}

/** A lead that stays put over a list body (`bodyInset: 'list'`), and a block above the footer. */
export const LeadAndList: Story = {
  args: {
    size: 'lg',
    eyebrow: 'MCP',
    title: 'Approve servers from .mcp.json?',
    bodyInset: 'list',
    lead: (
      <p className="fs-13 leading-[1.5] text-ink-400/90">
        This project lists three MCP servers. Approve the ones Claude may start.
      </p>
    ),
    aboveFooter: (
      <div className="rounded-[8px] border border-warning/30 px-3 py-2 fs-12.5 text-warning">
        Restart the session for changes to take effect.
      </div>
    ),
    footerCaption: '',
    footer: <Button variant="primary">Approve</Button>,
    children: (
      <ul className="flex flex-col">
        {['playwright', 'atlas', 'github'].map((name) => (
          <li key={name} className="border-b border-line/8 py-3 font-mono fs-12.5 text-ink-100">
            {name}
          </li>
        ))}
      </ul>
    ),
  },
}

/** The armed drop chrome while an image is dragged over the dialog. */
export const DropArmed: Story = {
  args: { ...Form.args, dropArmed: true },
}

/** `card`: the centred pairing confirmation, with content above the title. */
export const Card: Story = {
  args: {
    variant: 'card',
    eyebrow: 'PAIRING',
    title: 'Pixel 9 wants to join',
    beforeTitle: <span className="grid h-12 w-12 place-items-center rounded-xl border border-line/16 font-mono fs-12 text-ink-900/60">PX9</span>,
    footer: undefined,
    footerCaption: undefined,
    children: (
      <>
        <p className="fs-14 leading-[1.5] text-ink-400/90">Check that the code matches the one on the phone.</p>
        <div className="flex gap-2.5">
          <Button variant="ghost">Refuse</Button>
          <Button variant="primary">Pair</Button>
        </div>
      </>
    ),
  },
}

/** `review`: the 900px report dialog over another; the caller draws everything inside. */
export const Review: Story = {
  args: {
    variant: 'review',
    title: 'Send feedback',
    footer: undefined,
    footerCaption: undefined,
    children: (
      <div className="flex flex-col gap-3 p-7">
        <h2 className="fs-20 font-bold text-ink-100">Review the report</h2>
        <p className="fs-14 text-ink-400/90">Orbital 0.46.0 · macOS 27.2 · 3 sessions running</p>
      </div>
    ),
  },
}
