import type { Meta, StoryObj } from '@storybook/react-vite'
import { useRef } from 'react'
import { fn } from 'storybook/test'
import { BILLING } from '../../../site/demo/fake/fixtures'
import { api } from '../lib/api'
import type { CompletionContext } from '../lib/composerTokens'
import type { FileCompletionEntry, SlashCommand } from '../lib/types'
import { CompletionPopup } from './CompletionPopup'

/** The catalogue as `GET /api/commands` lists it: built-ins, the user's, the project's and a plugin's. */
const COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Start the conversation over', source: 'built-in' },
  { name: 'compact', description: 'Summarise the conversation to free context', source: 'built-in', argumentHint: '[instructions]' },
  { name: 'context', description: 'Show what fills the context window', source: 'built-in' },
  { name: 'release', description: 'Bump the versions and open the release PR', source: 'project' },
  { name: 'review', description: 'Review the branch against main', source: 'user' },
  { name: 'rewind', description: 'Go back to an earlier turn', source: 'built-in' },
  { name: 'superpowers:brainstorming', description: 'Explore a design before building it', source: 'plugin:superpowers' },
  { name: 'usage', description: 'Show the plan limits', source: 'built-in' },
]

/** One directory of the session's tree, the editor's open tab first. */
const FILES: FileCompletionEntry[] = [
  { name: 'retry.ts', dir: false, size: 1_840, path: 'src/lib/retry.ts', open: true },
  { name: 'webhooks', dir: true },
  { name: 'lib', dir: true },
  { name: 'index.ts', dir: false, size: 612 },
  { name: 'server.ts', dir: false, size: 4_310 },
]

/** `filesComplete` answers `FILES` for the story; the catalogue's fake server knows no tree. */
function stubFiles(): () => void {
  const real = api.filesComplete
  api.filesComplete = () => Promise.resolve(FILES)
  return () => {
    api.filesComplete = real
  }
}

interface DemoProps {
  context: CompletionContext
  placement: 'above' | 'below'
  commands: SlashCommand[] | null
}

/** The composer's well the list hangs off, matching its width. */
function CompletionDemo({ context, placement, commands }: DemoProps) {
  const wellRef = useRef<HTMLDivElement | null>(null)
  const typed = `${context.kind === 'command' ? '/' : '@'}${context.prefix}`
  return (
    <div className={['flex', placement === 'above' ? 'items-end' : 'items-start'].join(' ')} style={{ height: 420, width: 450 }}>
      <div ref={wellRef} className="w-full rounded-[12px] border border-line/16 bg-space/50 px-3.5 py-3 fs-13 text-ink-100">
        {typed}
        <span className="ml-px inline-block h-3.5 w-px translate-y-[2px] bg-accent" />
      </div>
      <CompletionPopup
        open
        anchorRef={wellRef}
        context={context}
        sessionKey={{ session: BILLING.id }}
        commands={commands}
        placement={placement}
        listboxId="story-completions"
        onAccept={fn()}
        onClose={fn()}
        onActiveDescendantChange={fn()}
      />
    </div>
  )
}

const meta = {
  title: 'Panels/CompletionPopup',
  component: CompletionDemo,
  beforeEach: stubFiles,
  args: { context: { kind: 'command', start: 0, prefix: '' }, placement: 'above', commands: COMMANDS },
} satisfies Meta<typeof CompletionDemo>
export default meta

type Story = StoryObj<typeof meta>

/** `/` typed: the catalogue, each row with its source; it scrolls past six rows. */
export const Commands: Story = {}

/** `/re` typed: the matches. */
export const CommandsFiltered: Story = { args: { context: { kind: 'command', start: 0, prefix: 're' } } }

/** `@src/` typed: the open tab first, then directories, then files. */
export const Files: Story = { args: { context: { kind: 'file', start: 0, prefix: 'src/' } } }

/** In the new-session dialog the list opens below the field. */
export const Below: Story = { args: { placement: 'below' } }
