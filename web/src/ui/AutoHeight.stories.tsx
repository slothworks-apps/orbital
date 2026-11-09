import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState, type ComponentProps } from 'react'
import { Button } from './Button'
import { AutoHeight } from './AutoHeight'

const LINES = [
  'Reading the relay handshake',
  'Running the shared tests',
  'Writing the changelog lines',
  'Bumping the desktop version',
  'Opening the pull request',
  'Waiting for CI',
]

function Lines({ count }: { count: number }) {
  return (
    <ul className="flex flex-col gap-1.5 p-3">
      {LINES.slice(0, count).map((line) => (
        <li key={line} className="fs-13 text-ink-400/90">
          {line}
        </li>
      ))}
    </ul>
  )
}

/** Add and remove lines to watch the box follow its content. */
function AutoHeightDemo(props: Omit<ComponentProps<typeof AutoHeight>, 'children'>) {
  const [count, setCount] = useState(props.scroll ? LINES.length : 2)
  return (
    <div className="flex w-[360px] flex-col gap-3">
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setCount((c) => Math.min(LINES.length, c + 1))}>
          Add a line
        </Button>
        <Button variant="ghost" onClick={() => setCount((c) => Math.max(0, c - 1))}>
          Remove
        </Button>
      </div>
      <div className={props.scroll ? 'flex max-h-[96px] flex-col' : ''}>
        <AutoHeight {...props} className="rounded-[10px] border border-line/14">
          <Lines count={count} />
        </AutoHeight>
      </div>
    </div>
  )
}

const meta = {
  title: 'UI/AutoHeight',
  component: AutoHeight,
  args: { scroll: false, children: null },
  render: (args) => <AutoHeightDemo scroll={args.scroll} />,
} satisfies Meta<typeof AutoHeight>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** `scroll`: capped by its parent, the box scrolls inside instead of overflowing. */
export const Scroll: Story = { args: { scroll: true } }
