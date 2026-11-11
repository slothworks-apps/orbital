import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { LIMIT_SUN_STYLE_KEY, LIMIT_SUNS_ENABLED_KEY } from '../lib/experimental'
import { LimitSunsSetting } from './LimitSunsSetting'

interface DemoProps {
  initial: Record<string, string>
  apiKey: boolean
}

/** Holds the settings the row writes, as Settings' own `patchAndSet` does. */
function LimitSunsDemo({ initial, apiKey }: DemoProps) {
  const [settings, setSettings] = useState<Record<string, string>>(initial)
  return (
    // Settings' content column.
    <div className="flex flex-col px-8" style={{ width: 824 }}>
      <LimitSunsSetting
        settings={settings}
        apiKey={apiKey}
        patchAndSet={(patch) => {
          setSettings((s) => ({ ...s, ...patch }))
          return Promise.resolve(true)
        }}
      />
    </div>
  )
}

const meta = {
  title: 'Panels/LimitSunsSetting',
  component: LimitSunsDemo,
  args: { initial: { [LIMIT_SUNS_ENABLED_KEY]: 'true' }, apiKey: false },
} satisfies Meta<typeof LimitSunsDemo>
export default meta

type Story = StoryObj<typeof meta>

/** On: the style, each account's star colour (the demo world's two accounts) and the reset. */
export const On: Story = {}

/** The Dim style picked. */
export const Dim: Story = { args: { initial: { [LIMIT_SUNS_ENABLED_KEY]: 'true', [LIMIT_SUN_STYLE_KEY]: 'dim' } } }

/** Off: the switch alone. */
export const Off: Story = { args: { initial: {} } }

/** Signed in with an API key: no plan windows, so the row is off and says why. */
export const ApiKey: Story = { args: { apiKey: true } }
