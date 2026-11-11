import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReactNode } from 'react'
import { fn } from 'storybook/test'
import {
  ClearGlyph,
  CollapseGlyph,
  CopyGlyph,
  CutGlyph,
  DetachGlyph,
  EditorGlyph,
  EndGlyph,
  FolderGlyph,
  HarnessGlyph,
  ImageGlyph,
  MentionGlyph,
  MoreGlyph,
  PageGlyph,
  PasteGlyph,
  RefreshGlyph,
  RewindGlyph,
  SelectAllGlyph,
  StatsGlyph,
  UtilityButton,
  WalkthroughGlyph,
  type UtilityButtonProps,
  type UtilityVariant,
} from './UtilityButton'

const meta = {
  title: 'UI/UtilityButton',
  component: UtilityButton,
  args: {
    variant: 'strip',
    active: false,
    open: false,
    disabled: false,
    'aria-label': 'Session stats',
    children: <StatsGlyph />,
    onClick: fn(),
  },
  argTypes: { children: { control: false } },
} satisfies Meta<typeof UtilityButton>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

const VARIANTS: UtilityVariant[] = ['strip', 'title']

const STATES: { state: string; props: Partial<UtilityButtonProps> }[] = [
  { state: 'resting', props: {} },
  { state: 'active', props: { active: true } },
  { state: 'open', props: { open: true } },
  { state: 'disabled', props: { disabled: true } },
]

/** Both boxes in every state the props give them; hover and focus are the browser's. */
export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-col gap-4">
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex gap-6">
          {STATES.map(({ state, props }) => (
            <div key={state} className="flex flex-col items-start gap-1.5">
              <UtilityButton {...args} {...props} variant={variant}>
                {variant === 'title' ? <RefreshGlyph spinning={state === 'active'} /> : args.children}
              </UtilityButton>
              <span className="font-mono fs-10.5 text-ink-900/60">
                {variant} · {state}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  ),
}

/** The detail header's strip, in the order the header lays it out. */
export const HeaderStrip: Story = {
  render: () => (
    <div className="flex items-center gap-1">
      <UtilityButton aria-label="Session stats">
        <StatsGlyph />
      </UtilityButton>
      <UtilityButton aria-label="Clear">
        <ClearGlyph />
      </UtilityButton>
      <UtilityButton aria-label="End session">
        <EndGlyph />
      </UtilityButton>
      <UtilityButton aria-label="More" open>
        <MoreGlyph />
      </UtilityButton>
      <UtilityButton aria-label="Open in its own window">
        <DetachGlyph />
      </UtilityButton>
      <UtilityButton aria-label="Collapse panel">
        <CollapseGlyph />
      </UtilityButton>
    </div>
  ),
}

/** Every `*Glyph` export, at each size or direction it takes, in the strip's resting ink. */
const GLYPHS: { name: string; glyph: ReactNode }[] = [
  { name: 'ClearGlyph', glyph: <ClearGlyph /> },
  { name: 'EndGlyph', glyph: <EndGlyph /> },
  { name: 'CollapseGlyph right', glyph: <CollapseGlyph /> },
  { name: 'CollapseGlyph left', glyph: <CollapseGlyph direction="left" /> },
  { name: 'MoreGlyph', glyph: <MoreGlyph /> },
  { name: 'HarnessGlyph', glyph: <HarnessGlyph /> },
  { name: 'WalkthroughGlyph', glyph: <WalkthroughGlyph /> },
  { name: 'DetachGlyph', glyph: <DetachGlyph /> },
  { name: 'RefreshGlyph', glyph: <RefreshGlyph /> },
  { name: 'RefreshGlyph spinning', glyph: <RefreshGlyph spinning /> },
  { name: 'RewindGlyph mark', glyph: <RewindGlyph /> },
  { name: 'RewindGlyph strip', glyph: <RewindGlyph size="strip" /> },
  { name: 'StatsGlyph header', glyph: <StatsGlyph /> },
  { name: 'StatsGlyph footer', glyph: <StatsGlyph size="footer" /> },
  { name: 'ImageGlyph', glyph: <ImageGlyph /> },
  { name: 'CopyGlyph', glyph: <CopyGlyph /> },
  { name: 'FolderGlyph', glyph: <FolderGlyph /> },
  { name: 'EditorGlyph', glyph: <EditorGlyph /> },
  { name: 'MentionGlyph', glyph: <MentionGlyph /> },
  { name: 'PageGlyph menu', glyph: <PageGlyph /> },
  { name: 'PageGlyph sheet', glyph: <PageGlyph size="sheet" /> },
  { name: 'CutGlyph', glyph: <CutGlyph /> },
  { name: 'PasteGlyph', glyph: <PasteGlyph /> },
  { name: 'SelectAllGlyph', glyph: <SelectAllGlyph /> },
]

export const Glyphs: Story = {
  render: () => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] items-start gap-4">
      {GLYPHS.map(({ name, glyph }) => (
        <div key={name} className="flex flex-col items-start gap-1.5">
          <UtilityButton aria-label={name}>{glyph}</UtilityButton>
          <span className="font-mono fs-10.5 text-ink-900/60">{name}</span>
        </div>
      ))}
    </div>
  ),
}
