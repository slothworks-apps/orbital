import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useRef, useState } from 'react'
import { fn } from 'storybook/test'
import { COLOUR_THEMES, COLOUR_THEME_KIND_LABEL, colourThemeNote } from '../lib/colourTheme'
import { tagColor } from '../lib/types'
import { KindGlyph } from './KindGlyph'
import { Select, type SelectHandle, type SelectOption, type SelectProps, type SelectSearch } from './Select'

type Variant = NonNullable<SelectProps<string>['variant']>

interface DemoProps extends SelectProps<string> {
  /** Opens the popup on mount, so a screenshot shows the list as well as the trigger. */
  openOnMount?: boolean
}

/** A select that holds its own value, so picking a row changes the trigger. */
function SelectDemo({ openOnMount = false, value: initial, onChange, ...props }: DemoProps) {
  const [value, setValue] = useState(initial)
  const ref = useRef<SelectHandle>(null)
  useEffect(() => {
    if (openOnMount) ref.current?.open()
  }, [openOnMount])
  return (
    <Select
      {...props}
      ref={ref}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

const PROJECTS: SelectOption<string>[] = [
  { value: 'orbital', label: '~/Projects/slothworks/orbital' },
  { value: 'infra', label: '~/Projects/slothworks/infra' },
  { value: 'site', label: '~/Projects/slothworks/orbital/site' },
  { value: 'dotfiles', label: '~/dotfiles' },
]

const TAGS: SelectOption<string>[] = [
  { value: 'relay', label: 'relay', dotColor: tagColor(205), count: 3 },
  { value: 'mobile', label: 'mobile', dotColor: tagColor(150), count: 5 },
  { value: 'design', label: 'design', dotColor: tagColor(300), count: 1 },
  { value: 'release', label: 'release', dotColor: tagColor(60), count: 2 },
]

const ORIGINS: SelectOption<string>[] = [
  { value: 'all', label: 'all sessions', count: 14 },
  { value: 'orbital', label: 'orbital sessions', count: 9 },
  { value: 'terminal', label: 'other terminals · read-only', short: 'read-only', count: 5 },
]

const DEVICES: SelectOption<string>[] = [
  { value: 'mac', label: 'MacBook Pro', glyph: <KindGlyph kind="desktop" untitled />, sub: 'this Mac' },
  { value: 'build', label: 'build-box', glyph: <KindGlyph kind="headless" untitled />, sub: 'headless · Linux' },
  {
    value: 'studio',
    label: 'Mac Studio',
    glyph: <KindGlyph kind="desktop" untitled />,
    sub: 'offline · seen 2 h ago',
    inert: true,
  },
]

const CHIP_MODELS: SelectOption<string>[] = [
  { value: 'opus', label: 'Opus', sub: 'deepest reasoning' },
  { value: 'sonnet', label: 'Sonnet', sub: 'balanced' },
  { value: 'haiku', label: 'Haiku', sub: 'fastest' },
]

const MODELS: SelectOption<string>[] = [
  { value: 'default', label: 'Default', sub: 'whatever Claude Code is set to' },
  { value: 'opus', label: 'Opus 4.6', sub: '1M ctx' },
  { value: 'sonnet', label: 'Sonnet 4.5', sub: '200K ctx' },
  { value: 'haiku', label: 'Haiku 4.5', sub: '200K ctx' },
  { value: 'other', label: 'Other', sub: 'any model id Claude Code accepts' },
]

const THEMES: SelectOption<string>[] = COLOUR_THEMES.map((theme) => ({
  value: theme.id,
  label: theme.name,
  group: COLOUR_THEME_KIND_LABEL[theme.kind],
  swatch: theme.swatch,
  trail: colourThemeNote(theme) ?? undefined,
  triggerTrail: theme.kind,
}))

const BRANCH_GROUPS = { current: 'CURRENT', all: 'ALL BRANCHES' }

const BRANCHES: SelectOption<string>[] = [
  { value: 'HEAD', label: 'main', sub: 'the main checkout', trail: 'local', triggerTrail: 'main checkout', group: BRANCH_GROUPS.current },
  { value: 'main', label: 'main', sub: 'default branch', trail: 'local', group: BRANCH_GROUPS.all },
  { value: 'fix/relay-reconnect', label: 'fix/relay-reconnect', trail: 'local', group: BRANCH_GROUPS.all },
  { value: 'docs/design-system-spec', label: 'docs/design-system-spec', trail: 'local', group: BRANCH_GROUPS.all },
  {
    value: 'origin/feature/media-viewer',
    label: 'origin/feature/media-viewer',
    labelLead: 'origin/',
    trail: 'remote',
    group: BRANCH_GROUPS.all,
  },
  { value: 'origin/main', label: 'origin/main', labelLead: 'origin/', trail: 'remote', group: BRANCH_GROUPS.all },
]

const BRANCH_SEARCH: SelectSearch<string> = {
  group: BRANCH_GROUPS.all,
  placeholder: 'Search local and remote branches',
  match: (option, query) => option.label.toLowerCase().includes(query.trim().toLowerCase()),
  empty: (query) => `No branch matches “${query}”`,
  maxHeight: 220,
}

/** Each variant with options shaped the way its caller in the app shapes them. */
const VARIANTS: Record<Variant, Omit<Partial<DemoProps>, 'onChange'> & Pick<DemoProps, 'options' | 'value'>> = {
  field: { options: PROJECTS, value: 'orbital', font: 'mono', className: 'w-[300px]' },
  pill: { options: TAGS, value: 'relay' },
  tag: { options: TAGS, value: 'mobile', footer: 'ONE TAG PER SESSION · SETS PLANET HUE' },
  ghost: { options: ORIGINS, value: 'terminal', active: true },
  device: {
    options: DEVICES,
    value: 'mac',
    footer: "PHONES DRIVE SESSIONS · THEY DON'T RUN THEM",
    className: 'w-[300px]',
  },
  chip: { options: CHIP_MODELS, value: 'opus' },
  swatch: { options: THEMES, value: 'deep-field', font: 'sans', className: 'w-[300px]' },
  branch: { options: BRANCHES, value: 'HEAD', search: BRANCH_SEARCH, className: 'w-[300px]' },
  model: { options: MODELS, value: 'opus', className: 'w-[300px]' },
}

const VARIANT_NAMES = Object.keys(VARIANTS) as Variant[]

const meta = {
  title: 'UI/Select',
  component: SelectDemo,
  args: {
    variant: 'field',
    font: 'mono',
    options: PROJECTS,
    value: 'orbital',
    onChange: fn(),
    'aria-label': 'Project',
    disabled: false,
  },
  argTypes: {
    variant: { control: 'select', options: VARIANT_NAMES },
    font: { control: 'inline-radio', options: ['mono', 'sans'] },
  },
} satisfies Meta<typeof SelectDemo>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = { args: { className: 'w-[300px]' } }

/** Every trigger, closed. The `Open*` stories below show each one's list. */
export const Variants: Story = {
  render: (args) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-start gap-6">
      {VARIANT_NAMES.map((variant) => (
        <div key={variant} className="flex flex-col items-start gap-1.5">
          <SelectDemo {...args} {...VARIANTS[variant]} variant={variant} aria-label={variant} />
          <span className="font-mono fs-10.5 text-ink-900/60">{variant}</span>
        </div>
      ))}
    </div>
  ),
}

export const Fonts: Story = {
  render: (args) => (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-start gap-1.5">
        <SelectDemo {...args} className="w-[300px]" font="mono" />
        <span className="font-mono fs-10.5 text-ink-900/60">mono</span>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <SelectDemo
          {...args}
          className="w-[300px]"
          font="sans"
          options={[
            { value: 'ask', label: 'Ask every time' },
            { value: 'last', label: 'Remember the last one' },
            { value: 'never', label: 'Never' },
          ]}
          value="last"
        />
        <span className="font-mono fs-10.5 text-ink-900/60">sans</span>
      </div>
    </div>
  ),
}

export const States: Story = {
  render: (args) => (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-start gap-1.5">
        <SelectDemo {...args} className="w-[300px]" disabled />
        <span className="font-mono fs-10.5 text-ink-900/60">disabled</span>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <SelectDemo {...args} className="w-[300px]" value="" placeholder="Pick a project" />
        <span className="font-mono fs-10.5 text-ink-900/60">placeholder · no match for value</span>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <SelectDemo {...args} {...VARIANTS.ghost} variant="ghost" active={false} value="all" />
        <span className="font-mono fs-10.5 text-ink-900/60">ghost · not active</span>
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <SelectDemo {...args} {...VARIANTS.branch} variant="branch" invalid />
        <span className="font-mono fs-10.5 text-ink-900/60">branch · invalid</span>
      </div>
    </div>
  ),
}

/** A story with one variant's popup opened on mount. */
const open = (variant: Variant): Story => ({
  args: { ...VARIANTS[variant], variant, openOnMount: true, 'aria-label': variant },
  render: (args) => (
    // Room under the trigger for the portalled list; the ghost and chip lists hang off the right edge.
    <div className={['min-h-[440px]', variant === 'ghost' || variant === 'chip' ? 'pl-[240px]' : ''].join(' ')}>
      <SelectDemo {...args} />
    </div>
  ),
})

export const OpenField = open('field')
export const OpenPill = open('pill')
export const OpenTag = open('tag')
export const OpenGhost = open('ghost')
export const OpenDevice = open('device')
export const OpenChip = open('chip')
export const OpenSwatch = open('swatch')
export const OpenBranch = open('branch')
export const OpenModel = open('model')
