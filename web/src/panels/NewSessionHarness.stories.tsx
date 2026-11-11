import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { DEFAULT_HARNESS_OPTIONS, type HarnessTemplate } from '../lib/types'
import { HarnessStep } from './NewSessionHarness'

const STEPS: HarnessTemplate['steps'] = [
  { id: 'read', title: 'Read the task', instructions: '', mode: 'auto', doneWhen: '' },
  { id: 'build', title: 'Implement it', instructions: '', mode: 'auto', doneWhen: '' },
  { id: 'review', title: 'Review before the PR', instructions: '', mode: 'gate', doneWhen: '' },
]

const template = (over: Partial<HarnessTemplate> & Pick<HarnessTemplate, 'id' | 'name' | 'inputs'>): HarnessTemplate => ({
  description: 'From the task through a review of its own to an open PR.',
  tags: [],
  steps: STEPS,
  options: DEFAULT_HARNESS_OPTIONS,
  scope: { kind: 'project', root: '/w/orbital', name: 'orbital' },
  draft: false,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

/** Short hints. */
const SHORT = template({
  id: 1,
  name: 'Bug fix',
  inputs: [
    { key: 'task', label: 'Task link', hint: 'Linear or GitHub issue' },
    { key: 'where', label: 'Where', hint: 'optional · a folder' },
  ],
})

/** Hints longer than a line beside their label, and a two-word label. */
const LONG = template({
  id: 2,
  name: 'ClickUp task',
  inputs: [
    { key: 'task', label: 'ClickUp task', hint: 'URL of the ClickUp task to implement' },
    { key: 'spec', label: 'Tech spec (ClickUp)', hint: 'URL of the ClickUp document with the tech spec, when there is one' },
    {
      key: 'base',
      label: 'Base branch',
      hint: 'The branch the new branch starts from, when the task builds on another one that is not merged yet; otherwise main',
    },
  ],
})

function Step({ selected }: { selected: HarnessTemplate }) {
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [lucky, setLucky] = useState(false)
  return (
    <div className="flex h-[640px] w-[864px] flex-col">
      <HarnessStep
        remote={false}
        deviceName="this device"
        view={{
          load: {
            key: 'story',
            status: 'ready',
            answer: { project: { root: '/w/orbital', name: 'orbital' }, templates: [SHORT, LONG], lastUsedId: selected.id },
          },
          selected,
          inputs,
          lucky,
          dirNote: null,
          pick: () => {},
          setInput: (key, value) => setInputs((all) => ({ ...all, [key]: value })),
          setLucky,
        }}
      />
    </div>
  )
}

const meta = {
  title: 'Panels/NewSessionHarness',
  component: Step,
  args: { selected: SHORT },
} satisfies Meta<typeof Step>
export default meta

type Story = StoryObj<typeof meta>

export const ShortHints: Story = {}

/** 65e: the label on one line, the hint whole under it, however long. */
export const LongHints: Story = { args: { selected: LONG } }
