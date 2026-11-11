import type { Meta, StoryObj } from '@storybook/react-vite'
import mapShot from '../../../site/public/demo-images/map.webp'
import sessionShot from '../../../site/public/demo-images/session.webp'
import { BILLING, DEMO_EPOCH, MESSAGES } from '../../../site/demo/fake/fixtures'
import { promptWithFiles } from '../lib/attachedFiles'
import { promptWithSelection } from '../lib/ideSelection'
import { apiFileImagePath, apiImagePath, configureImages } from '../lib/images'
import type { ChatMessage } from '../lib/types'
import { MessageView } from './MessageView'

const CWD = BILLING.cwd
const at = new Date(DEMO_EPOCH - 4 * 60_000).toISOString()

const USER: ChatMessage = MESSAGES.billing[0]

const ASSISTANT_MARKDOWN: ChatMessage = {
  id: 'story-assistant',
  role: 'assistant',
  timestamp: at,
  cwd: CWD,
  model: 'claude-opus-5[1m]',
  text: [
    'The sender now retries on a 5xx with exponential backoff. What changed:',
    '',
    '- `src/webhooks/sender.ts` wraps the post in `withRetry`, five attempts.',
    '- `src/lib/backoff.ts` is new: the delay doubles from 500 ms and stops at 30 s.',
    '',
    '```ts',
    'export function backoff(attempt: number): number {',
    '  return Math.min(30_000, 500 * 2 ** attempt)',
    '}',
    '```',
    '',
    '| attempt | delay |',
    '|---|---|',
    '| 1 | 1 s |',
    '| 5 | 16 s |',
    '',
    'The tests pass; see [the retry helper](src/lib/retry.ts) for the jitter.',
  ].join('\n'),
}

const COMMAND_TURN: ChatMessage = {
  id: 'story-command',
  role: 'user',
  timestamp: at,
  text: 'Then run the release checklist.',
  command: {
    name: '/release',
    body: '# Release\n\n1. Bump the version in desktop/package.json.\n2. Move the Unreleased lines into the new version.\n3. Run node scripts/check-versions.mjs.\n4. Open the PR.',
    blocks: 1,
  },
}

const MACHINE_CONTEXT: ChatMessage = {
  id: 'story-machine',
  role: 'user',
  timestamp: at,
  text: '',
  command: { name: null, body: '<task-notification>\nThe background shell dev-1 exited with code 0.\n</task-notification>', blocks: 2 },
}

const IMAGES_TURN: ChatMessage = {
  id: 'story-images',
  role: 'user',
  timestamp: at,
  text: 'The map and the panel after the change — does the gap under the header look right?',
  images: [
    { ref: 'map', w: 1440, h: 900, bytes: 26_166 },
    { ref: 'session', w: 900, h: 1600, bytes: 59_476 },
  ],
}

const IMAGE_ONLY: ChatMessage = {
  id: 'story-image-only',
  role: 'user',
  timestamp: at,
  text: '',
  images: [{ ref: 'map', w: 1440, h: 900, bytes: 26_166 }],
}

const FILES_TURN: ChatMessage = {
  id: 'story-files',
  role: 'user',
  timestamp: at,
  text: promptWithFiles('Use these two as the fixtures for the retry tests.', [
    `${CWD}/fixtures/webhook-503.json`,
    `${CWD}/fixtures/webhook-timeout.har`,
  ]),
}

const SELECTION_TURN: ChatMessage = {
  id: 'story-selection',
  role: 'user',
  timestamp: at,
  text: promptWithSelection('Why does this give up after the first 5xx?', CWD, {
    filePath: `${CWD}/src/webhooks/sender.ts`,
    lineStart: 42,
    lineCount: 6,
    text: 'try {\n  await post(endpoint.url, payload)\n} catch (err) {\n  log.warn(err)\n  return\n}',
  }),
}

/** The two refs answer with screenshots of Orbital itself; the catalogue has no image store. */
function standInImages(): () => void {
  configureImages({ resolve: (ref) => (ref === 'session' ? sessionShot : mapShot) })
  return () => configureImages({ resolve: apiImagePath, resolvePath: apiFileImagePath })
}

const meta = {
  title: 'Panels/MessageView',
  component: MessageView,
  args: { message: USER, streaming: false, waiting: false },
  // The transcript's content column.
  render: (args) => (
    <div style={{ width: 406 }}>
      <MessageView {...args} />
    </div>
  ),
} satisfies Meta<typeof MessageView>
export default meta

type Story = StoryObj<typeof meta>

/** The user's turn: the accent bubble on the right. */
export const User: Story = {}

/** The assistant's turn: plain prose, markdown with a list, code, a table and a link. */
export const Assistant: Story = { args: { message: ASSISTANT_MARKDOWN } }

/** Still streaming: the caret trails the last word. */
export const Streaming: Story = { args: { message: { ...ASSISTANT_MARKDOWN, text: 'The sender now retries on a 5xx with' }, streaming: true } }

/** Waiting behind a hook: dashed and unfilled until it goes out. */
export const Waiting: Story = { args: { waiting: true } }

/** The rewind target, and the one being previewed. */
export const RewindMarks: Story = {
  render: () => (
    <div className="flex flex-col gap-4" style={{ width: 406 }}>
      <MessageView message={USER} rewindMark="target" />
      <MessageView message={USER} rewindMark="active" />
    </div>
  ),
}

/** A slash command's expansion folded behind its chip. */
export const Command: Story = { args: { message: COMMAND_TURN } }

/** The chip opened: the expansion verbatim. */
export const CommandOpen: Story = {
  args: { message: COMMAND_TURN },
  play: ({ canvasElement }) => canvasElement.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click(),
}

/** Machine context nobody typed: on the agent's side, no bubble. */
export const MachineContext: Story = { args: { message: MACHINE_CONTEXT } }

/** Text and two images: two-up under the bubble. */
export const WithImages: Story = { beforeEach: standInImages, args: { message: IMAGES_TURN } }

/** An image alone: the thumbnail is the bubble. */
export const ImageOnly: Story = { beforeEach: standInImages, args: { message: IMAGE_ONLY } }

/** A waiting turn with an image: one dashed box, the image over the text. */
export const WaitingWithImage: Story = {
  beforeEach: standInImages,
  args: { message: { ...IMAGE_ONLY, text: 'Is this the gap you meant?' }, waiting: true },
}

/** Files that rode with the turn: receipts under the bubble. */
export const SentFiles: Story = { args: { message: FILES_TURN } }

/** An editor selection that rode with the turn: the caption names the lines. */
export const SentSelection: Story = { args: { message: SELECTION_TURN } }
