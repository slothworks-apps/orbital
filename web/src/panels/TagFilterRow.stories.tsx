import type { Meta, StoryObj } from '@storybook/react-vite'
import { TAGS } from '../../../site/demo/fake/fixtures'
import type { Tag } from '../lib/types'
import { useOrbital } from '../store/store'
import { TagFilterRow } from './TagFilterRow'

/** More tags than the demo world has, so the row wraps the way a busy sidebar's does. */
const MANY_TAGS: Tag[] = [
  ...TAGS,
  { id: 4, name: 'design', hue: 300, is_default: 0 },
  { id: 5, name: 'release', hue: 60, is_default: 0 },
  { id: 6, name: 'research', hue: 260, is_default: 0 },
  { id: 7, name: 'infra', hue: 180, is_default: 0 },
]

/** The tags and the filter the row reads, put back after the story. */
function seedStore(tags: Tag[], filterTagIds: number[]): () => () => void {
  return () => {
    const before = useOrbital.getState()
    useOrbital.setState({ tags, ui: { ...before.ui, filterTagIds } })
    return () => useOrbital.setState(before, true)
  }
}

const meta = {
  title: 'Panels/TagFilterRow',
  component: TagFilterRow,
  beforeEach: seedStore(TAGS, []),
  // The sidebar's 300px column, with the row's own padding.
  args: { className: 'flex flex-wrap gap-1.5 px-3.5 pb-1.5 pt-3' },
  render: (args) => (
    <div className="rounded-[14px] border border-line/14 bg-panel/90" style={{ width: 300 }}>
      <TagFilterRow {...args} />
    </div>
  ),
} satisfies Meta<typeof TagFilterRow>
export default meta

type Story = StoryObj<typeof meta>

/** No filter: every chip at rest. */
export const NoFilter: Story = {}

/** One tag on: it lights and Clear ends the row. */
export const OneOn: Story = { beforeEach: seedStore(TAGS, [2]) }

/** Several tags, two on, wrapping onto a second line. */
export const ManyTags: Story = { beforeEach: seedStore(MANY_TAGS, [1, 5]) }
