import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { userEvent } from 'storybook/test'
import { BILLING, DOCS, INFRA, MOBILE, QUIET, projects } from '../../../site/demo/fake/fixtures'
import { DirectoryField } from './DirectoryField'

const PROJECTS = projects([BILLING, DOCS, MOBILE, INFRA, ...QUIET])

/** The field holds its own value, the way New session's form does. */
function FieldDemo({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  return (
    <div className="flex h-[420px] w-[520px] flex-col gap-1.5">
      <label htmlFor="project-dir" className="font-mono fs-10 tracking-[0.16em] text-ink-900/60">
        PROJECT DIRECTORY
      </label>
      <div className="flex">
        <DirectoryField id="project-dir" value={value} onChange={setValue} projects={PROJECTS} />
      </div>
    </div>
  )
}

const meta = {
  title: 'Panels/DirectoryField',
  component: FieldDemo,
  args: { initial: BILLING.cwd },
} satisfies Meta<typeof FieldDemo>
export default meta

type Story = StoryObj<typeof meta>

/** At rest, holding the prefilled directory. */
export const Closed: Story = {}

/** Focused: the most recent directories, nothing highlighted until ↓. */
export const Recent: Story = {
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLInputElement>('#project-dir')?.focus()
  },
}

/** Typed: every directory whose path holds the query, the match marked; ↓ highlights a row. */
export const Searching: Story = {
  args: { initial: '' },
  play: async ({ canvasElement }) => {
    const input = canvasElement.querySelector<HTMLInputElement>('#project-dir')
    if (!input) return
    await userEvent.type(input, 'app')
    await userEvent.keyboard('{ArrowDown}')
  },
}
