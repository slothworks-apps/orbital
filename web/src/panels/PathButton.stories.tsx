import type { Meta, StoryObj } from '@storybook/react-vite'
import { BILLING } from '../../../site/demo/fake/fixtures'
import { api } from '../lib/api'
import type { FoundFile } from '../lib/findByName'
import type { ApiSession } from '../lib/types'
import { useOrbital } from '../store/store'
import { PathButton } from './PathButton'

const CWD = BILLING.cwd
const PATH = 'src/webhooks/sender.ts'

/** The billing session, selected, with WebStorm open on its directory. */
const SESSION: ApiSession = {
  ...BILLING,
  ide: { ideName: 'WebStorm', workspaceRoot: CWD, selection: null },
  ides: [{ id: 'webstorm', ideName: 'WebStorm', workspaceRoot: CWD }],
}

const MATCHES: FoundFile[] = [
  { path: `${CWD}/src/webhooks/sender.ts`, relative: 'src/webhooks/sender.ts', touched: true },
  { path: `${CWD}/src/email/sender.ts`, relative: 'src/email/sender.ts', touched: false },
  { path: `${CWD}/test/webhooks/sender.ts`, relative: 'test/webhooks/sender.ts', touched: false },
]

/**
 * The session selected, the viewer on `openPath` if any, and the two lookups
 * a press and a right-click make answered here; the catalogue's fake server
 * knows no files.
 */
function seed(openPath: string | null = null): () => () => void {
  return () => {
    const before = useOrbital.getState()
    const realLocate = api.locateFile
    const realFind = api.findFiles
    api.locateFile = (_session, path) => Promise.resolve(path.startsWith('/') ? path : `${CWD}/${path}`)
    api.findFiles = () => Promise.resolve({ matches: MATCHES, more: 0 })
    useOrbital.setState({
      sessions: { [SESSION.id]: SESSION },
      ui: { ...before.ui, selectedId: SESSION.id, fileViewer: openPath ? { path: openPath, line: null } : null },
    })
    return () => {
      useOrbital.setState(before, true)
      api.locateFile = realLocate
      api.findFiles = realFind
    }
  }
}

/** Right-clicks the first path, as the desktop opens its menu. */
const rightClick: Story['play'] = ({ canvasElement }) => {
  const path = canvasElement.querySelector<HTMLElement>('[data-path-button]')
  if (!path) return
  const box = path.getBoundingClientRect()
  path.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 12, clientY: box.bottom }))
}

const meta = {
  title: 'Panels/PathButton',
  component: PathButton,
  beforeEach: seed(),
  args: { path: PATH, line: null, variant: 'row', bare: false },
  // A tool row's label, in the transcript's content column.
  render: (args) => (
    <div className="font-mono fs-11.5 text-ink-500/80" style={{ width: 406, height: 320 }}>
      Read: <PathButton {...args} />
    </div>
  ),
} satisfies Meta<typeof PathButton>
export default meta

type Story = StoryObj<typeof meta>

export const Playground: Story = {}

/** Each place a path is pressable: a tool row, its input, assistant prose, inside inline code. */
export const Variants: Story = {
  render: () => (
    <div className="flex flex-col gap-4" style={{ width: 406 }}>
      <div className="font-mono fs-11.5 text-ink-500/80">
        Read: <PathButton path={PATH} variant="row" />
      </div>
      <div className="font-mono fs-10.5 text-ink-200/90">
        {'{ "file_path": "'}
        <PathButton path={`${CWD}/${PATH}`} variant="input" />
        {'" }'}
      </div>
      <p className="fs-13 leading-[1.55] text-ink-100/92">
        The retry lives in <PathButton path={PATH} line={42} variant="prose" /> now, next to the post it wraps.
      </p>
      <p className="fs-13 leading-[1.55] text-ink-100/92">
        See{' '}
        <code className="rounded-[4px] bg-line/10 px-1 font-mono fs-11.5">
          <PathButton path="src/lib/retry.ts" variant="code" />
        </code>{' '}
        for the jitter.
      </p>
    </div>
  ),
}

/** With a line: the `:42` suffix in the muted ink. */
export const WithLine: Story = { args: { line: 42, variant: 'prose' } }

/** Its file is open in the viewer: dimmed, and a press does nothing. */
export const OpenInViewer: Story = { beforeEach: seed(PATH) }

/** A right-click: the actions for the located file. */
export const ContextMenu: Story = { play: rightClick }

/** A bare name with several matches, right-clicked: the chooser first. */
export const BareNameChooser: Story = { args: { path: 'sender.ts', bare: true }, play: rightClick }
