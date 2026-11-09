import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef } from 'react'
import { fn } from 'storybook/test'
import { Button } from './Button'
import { MENU_SEPARATOR, MenuButton, MenuPopup, type MenuButtonProps, type MenuEntry } from './Menu'

const SESSION_ACTIONS: MenuEntry[] = [
  { key: 'pin', label: 'Pin to the map', icon: '◆', onSelect: fn() },
  { key: 'rename', label: 'Rename…', icon: '✎', onSelect: fn() },
  { key: 'tag', label: 'Change tag', icon: '●', detail: 'orbital', keepsOpen: true, onSelect: fn() },
  MENU_SEPARATOR,
  { key: 'stats', label: 'Session stats', icon: '▤', detail: '1.8M tok', onSelect: fn() },
  { key: 'walkthrough', label: 'Walkthrough', icon: '▶', disabled: true, onSelect: fn() },
  MENU_SEPARATOR,
  { key: 'end', label: 'End session', icon: '×', onSelect: fn() },
]

const AGENTS: MenuEntry[] = [
  { heading: 'Running' },
  { key: 'a1', label: 'Explore the relay handshake', selected: true, onSelect: fn() },
  { key: 'a2', label: 'Write the changelog lines', selected: false, onSelect: fn() },
  { heading: 'Ended' },
  { key: 'a3', label: 'Check the version copies', selected: false, onSelect: fn() },
  { key: 'a4', label: 'Review the Android manifest', selected: false, onSelect: fn() },
  { key: 'a5', label: 'Grep for literal colours', selected: false, onSelect: fn() },
  { key: 'a6', label: 'Screenshot the stories', selected: false, onSelect: fn() },
]

const PATHS: MenuEntry[] = [
  { heading: '~/Projects/slothworks/orbital/web/src/ui', caption: true },
  { key: 'open', label: 'Open in Finder', icon: '▢', onSelect: fn() },
  { key: 'copy', label: 'Copy path', icon: '⧉', onSelect: fn() },
  { note: '+14 more', inset: true },
  { note: 'NO MATCH' },
]

const CUSTOM_BODY: MenuEntry[] = [
  {
    key: 'opus',
    label: 'Opus',
    selected: true,
    body: (
      <span className="flex flex-col">
        <span className="fs-12.5 font-semibold">Opus</span>
        <span className="font-mono fs-10 text-ink-900/55">the deepest · slower</span>
      </span>
    ),
    onSelect: fn(),
  },
  {
    key: 'sonnet',
    label: 'Sonnet',
    selected: false,
    body: (
      <span className="flex flex-col">
        <span className="fs-12.5 font-semibold">Sonnet</span>
        <span className="font-mono fs-10 text-ink-900/55">balanced</span>
      </span>
    ),
    onSelect: fn(),
  },
]

const trigger: MenuButtonProps['renderTrigger'] = (props, open) => (
  <Button {...props} variant={open ? 'pill-active' : 'pill'}>
    ⋯ Session
  </Button>
)

/** Opens the menu as the story mounts, so the catalogue shows it open. */
const openOnMount: Story['play'] = ({ canvasElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.click()
}

const meta = {
  title: 'UI/Menu',
  component: MenuButton,
  args: {
    'aria-label': 'Session actions',
    entries: SESSION_ACTIONS,
    renderTrigger: trigger,
    align: 'left',
    prefer: 'below',
    widthPx: 252,
    onOpenChange: fn(),
  },
  render: (args) => (
    <div className="h-[420px]">
      <MenuButton {...args} />
    </div>
  ),
} satisfies Meta<typeof MenuButton>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** Rows with glyphs, read-outs, a disabled row and hairlines. */
export const Open: Story = { play: openOnMount }

/** Group headings and the ✓ column, the list capped at `maxRows` and scrolling inside. */
export const SelectedAndHeadings: Story = {
  args: { 'aria-label': 'Subagents', entries: AGENTS, maxRows: 4 },
  play: openOnMount,
}

/** The path menu's caption over a hairline, and its notes. */
export const CaptionAndNotes: Story = {
  args: { 'aria-label': 'Path', entries: PATHS, widthPx: 300 },
  play: openOnMount,
}

/** Rows that draw their own `body`. */
export const CustomBody: Story = {
  args: { 'aria-label': 'Model', entries: CUSTOM_BODY, widthPx: 220 },
  play: openOnMount,
}

/** A key-hint strip under the list, outside its scroll. */
export const WithFooter: Story = {
  args: {
    footer: (
      <div className="mt-1 border-t border-line/10 px-2 pt-2 pb-1 font-mono fs-10 text-ink-900/50">↑↓ move · ↵ run · esc close</div>
    ),
  },
  play: openOnMount,
}

/** `align: 'right'` lines the popup up with the trigger's right edge; `prefer: 'above'` opens upward. */
export const AlignRightAbove: Story = {
  args: { align: 'right', prefer: 'above' },
  render: (args) => (
    <div className="flex h-[420px] items-end justify-end">
      <MenuButton {...args} />
    </div>
  ),
  play: openOnMount,
}

/** `MenuPopup` on its own: the open menu, hung off any anchor. `MenuButton` and `ContextMenu` both render it. */
export const Popup: Story = {
  render: (args) => <PopupDemo entries={args.entries} />,
}

function PopupDemo({ entries }: { entries: readonly MenuEntry[] }) {
  const anchor = useRef<HTMLSpanElement | null>(null)
  return (
    <div className="h-[420px]">
      <span ref={anchor} className="font-mono fs-11 text-ink-900/60">
        anchor
      </span>
      <MenuPopup
        aria-label="Session actions"
        entries={entries}
        anchorRef={anchor}
        position={{ gap: 4, align: 'left' }}
        widthPx={252}
        initial="first"
        onClose={() => {}}
      />
    </div>
  )
}
