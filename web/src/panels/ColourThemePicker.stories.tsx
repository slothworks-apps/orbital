import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { COLOUR_THEME_FOLLOW_SYSTEM_KEY } from '../lib/colourTheme'
import { ColourThemeRows } from './ColourThemePicker'

type Settings = Record<string, string | undefined>

/**
 * The rows hold their settings here instead of PATCHing them, so a pick
 * changes what the rows show without repainting the catalogue's own theme.
 */
function ColourRowsDemo({ initial }: { initial: Settings }) {
  const [settings, setSettings] = useState<Settings>(initial)
  return (
    <div className="w-[680px]">
      <ColourThemeRows
        settings={settings}
        patchAndSet={(patch) => {
          setSettings((s) => ({ ...s, ...patch }))
          return Promise.resolve(true)
        }}
      />
    </div>
  )
}

const meta = {
  title: 'Panels/ColourThemePicker',
  component: ColourRowsDemo,
  args: { initial: {} },
} satisfies Meta<typeof ColourRowsDemo>
export default meta

type Story = StoryObj<typeof meta>

/** One theme for the app. */
export const OneTheme: Story = {}

/** Following macOS: a theme for each appearance. */
export const FollowTheSystem: Story = { args: { initial: { [COLOUR_THEME_FOLLOW_SYSTEM_KEY]: 'true' } } }

/** The picker opened: every theme under its kind, with its swatch. */
export const Open: Story = {
  render: (args) => (
    <div className="h-[560px]">
      <ColourRowsDemo {...args} />
    </div>
  ),
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[aria-label="Colours"]')?.click()
  },
}
