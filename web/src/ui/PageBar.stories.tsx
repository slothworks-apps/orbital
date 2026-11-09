import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ApiSession, Tag } from '../lib/types'
import { PageBar } from './PageBar'

/** Only the fields the bar reads: its path, branch, status and tags. */
const SESSION = {
  id: 'b7e1c2d4',
  cwd: '/Users/tomin/Projects/slothworks/orbital',
  title: 'Fix the relay handshake',
  status: 'working',
  pendingDecision: null,
  tagIds: [1],
  git: { ref: 'fix/relay-handshake' },
} as unknown as ApiSession

/** The bar reads the tags itself for the session crumb's dot; the catalogue has no server, so this answers it. */
const TAGS: Tag[] = [{ id: 1, name: 'orbital', hue: 210, is_default: 1 }]

function standInTags() {
  const real = window.fetch
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (new URL(url, window.location.href).pathname === '/api/tags') {
      return Promise.resolve(Response.json({ tags: TAGS }))
    }
    return real(input, init)
  }
  return () => {
    window.fetch = real
  }
}

/** Something to scroll under a `sky` bar. */
function Page() {
  return (
    <div className="flex flex-col gap-3 px-[34px] py-6">
      {['This week', 'Tokens by model', 'Opus · 1.8M', 'Sessions by project'].map((line) => (
        <div key={line} className="h-24 rounded-[12px] border border-line/12 px-5 py-4 fs-13 text-ink-900/60">
          {line}
        </div>
      ))}
    </div>
  )
}

const meta = {
  title: 'UI/PageBar',
  component: PageBar,
  parameters: { layout: 'fullscreen' },
  beforeEach: standInTags,
  args: { route: { page: 'stats' }, surface: 'sky', session: null, notice: null },
  render: (args) => (
    <div className="min-h-[360px]">
      <PageBar {...args} />
      <Page />
    </div>
  ),
} satisfies Meta<typeof PageBar>
export default meta

type Story = StoryObj<typeof meta>

/** `/stats`: ORBITAL / STATS over the `sky` surface. */
export const Playground: Story = {}

export const Limits: Story = { args: { route: { page: 'limits' } } }

/** The drilldown: a session crumb, its path and branch, the status chip. */
export const Drilldown: Story = {
  args: { route: { page: 'drilldown', title: 'Fix the relay handshake' }, session: SESSION },
}

/** The walkthrough's cover over the `columns` surface: fill and hairline always on. */
export const WalkthroughCover: Story = {
  args: {
    route: { page: 'walkthrough', id: 'b7e1c2d4', title: 'Fix the relay handshake', screen: { kind: 'cover' } },
    surface: 'columns',
    session: SESSION,
  },
}

/** A walkthrough step, with the notice ahead of the path. */
export const WalkthroughStep: Story = {
  args: {
    route: {
      page: 'walkthrough',
      id: 'b7e1c2d4',
      title: 'Fix the relay handshake',
      screen: { kind: 'step', n: 3, total: 7 },
    },
    surface: 'columns',
    session: SESSION,
    notice: 'steps may be added',
  },
}

export const WalkthroughClose: Story = {
  args: {
    route: { page: 'walkthrough', id: 'b7e1c2d4', title: 'Fix the relay handshake', screen: { kind: 'close' } },
    surface: 'columns',
    session: { ...SESSION, status: 'ended' },
  },
}
