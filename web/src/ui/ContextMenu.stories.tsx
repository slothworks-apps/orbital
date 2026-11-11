import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState, type MouseEvent } from 'react'
import { fn } from 'storybook/test'
import { ContextMenu, type ContextMenuProps } from './ContextMenu'
import { MENU_SEPARATOR, type MenuEntry } from './Menu'

const ENTRIES: MenuEntry[] = [
  { key: 'open', label: 'Open', icon: '↗', onSelect: fn() },
  { key: 'window', label: 'Open in new window', icon: '⧉', onSelect: fn() },
  { key: 'pin', label: 'Pin to the map', icon: '◆', onSelect: fn() },
  { key: 'tag', label: 'Change tag', icon: '●', detail: 'orbital', keepsOpen: true, onSelect: fn() },
  MENU_SEPARATOR,
  { key: 'end', label: 'End session', icon: '×', onSelect: fn() },
]

const TAGS: MenuEntry[] = [
  { key: 'back', label: '← Back', keepsOpen: true, onSelect: fn() },
  MENU_SEPARATOR,
  { key: 'orbital', label: 'orbital', selected: true, onSelect: fn() },
  { key: 'infra', label: 'slothworks-infra', selected: false, onSelect: fn() },
  { key: 'beam', label: 'beam', selected: false, onSelect: fn() },
]

const meta = {
  title: 'UI/ContextMenu',
  component: ContextMenu,
  parameters: { layout: 'fullscreen' },
  args: {
    at: { x: 120, y: 80 },
    entries: ENTRIES,
    'aria-label': 'Session',
    widthPx: 232,
    onClose: fn(),
  },
  render: (args) => (
    <div className="h-[460px]">
      <ContextMenu {...args} />
    </div>
  ),
} satisfies Meta<typeof ContextMenu>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** Open at a point, as a right-click leaves it. */
export const Open: Story = {}

/** The rows swapped in place (`view`): the tag list with its ✓ column. */
export const TagView: Story = {
  args: { entries: TAGS, view: 'tags', onBack: fn() },
}

/** Near the window's corner it flips to stay on screen. */
export const AtTheEdge: Story = {
  args: { at: { x: 1150, y: 420 } },
}

/** Opened by a right-click anywhere in the box. */
export const WithTrigger: Story = {
  render: (args) => <ContextMenuDemo {...args} />,
}

function ContextMenuDemo(props: ContextMenuProps) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    setAt({ x: e.clientX, y: e.clientY })
  }
  return (
    <div className="h-[460px] p-6">
      <div
        onContextMenu={onContextMenu}
        className="grid h-40 w-80 place-items-center rounded-[12px] border border-dashed border-line/20 fs-13 text-ink-900/60"
      >
        Right-click: Fix the relay handshake
      </div>
      {at && <ContextMenu {...props} key={`${at.x},${at.y}`} at={at} onClose={() => setAt(null)} />}
    </div>
  )
}

/** `at` an element: the menu hangs under it, left edges lined up (the bare-name chooser under its chip). */
export const UnderElement: Story = {
  render: (args) => <UnderElementDemo {...args} />,
}

function UnderElementDemo(props: ContextMenuProps) {
  const [chip, setChip] = useState<HTMLSpanElement | null>(null)
  return (
    <div className="h-[460px] p-10">
      <span ref={setChip} className="rounded-full border border-line/16 px-3 py-1 font-mono fs-11 text-ink-100">
        Panel.tsx
      </span>
      {chip && <ContextMenu {...props} at={chip} />}
    </div>
  )
}
