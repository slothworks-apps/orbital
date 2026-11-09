import type { Meta, StoryObj } from '@storybook/react-vite'
import { MOBILE } from '../../../site/demo/fake/fixtures'
import { useCompactionUi } from '../store/compaction'
import { CompactDialog } from './CompactDialog'

/** The dialog opens on `useCompactionUi.confirm`, which the composer's `/compact` parks there. */
function park(count: number): () => () => void {
  return () => {
    useCompactionUi.setState({ confirm: { sessionId: MOBILE.id, text: '/compact', count } })
    return () => useCompactionUi.setState({ confirm: null })
  }
}

const meta = {
  title: 'Panels/CompactDialog',
  component: CompactDialog,
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div className="min-h-screen">
      <CompactDialog />
    </div>
  ),
} satisfies Meta<typeof CompactDialog>
export default meta

type Story = StoryObj<typeof meta>

/** Three subagents still running: the plural wording. */
export const Open: Story = { beforeEach: park(3) }

/** One subagent: the singular wording. */
export const OneSubagent: Story = { beforeEach: park(1) }
