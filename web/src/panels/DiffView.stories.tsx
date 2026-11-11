import type { Meta, StoryObj } from '@storybook/react-vite'
import { BILLING_DECISION } from '../../../site/demo/fake/fixtures'
import { describeFileChange, type FileChange } from '../lib/fileEdit'
import { ChangeView, changeSectionLabel } from './DiffView'

const SENDER = '/Users/demo/code/billing-api/src/webhooks/sender.ts'

const BEFORE = `import { post } from '../http'
import type { Endpoint, Payload } from './types'

export async function deliver(endpoint: Endpoint, payload: Payload) {
  const started = Date.now()
  await post(endpoint.url, payload)
  log.info('delivered', { endpoint: endpoint.id, ms: Date.now() - started })
}
`

const AFTER = `import { post } from '../http'
import { withRetry } from '../retry'
import type { Endpoint, Payload } from './types'

export async function deliver(endpoint: Endpoint, payload: Payload) {
  const started = Date.now()
  await withRetry(() => post(endpoint.url, payload), {
    attempts: 5,
    backoff: 'exponential',
  })
  log.info('delivered', { endpoint: endpoint.id, ms: Date.now() - started })
}
`

const LONG_AFTER = AFTER + Array.from({ length: 30 }, (_, i) => `export const RETRY_${i} = ${i * 30}\n`).join('')

function change(toolName: string, input: Record<string, unknown>, result?: string, isError?: boolean): FileChange {
  const described = describeFileChange(toolName, input, result, isError)
  if (!described) throw new Error(`not a file change: ${toolName}`)
  return described
}

const EDIT = change('Edit', { file_path: SENDER, old_string: BEFORE, new_string: AFTER })

/** The tool row's section label over the block, in the transcript column of the detail panel. */
function Labelled({ change: c, isError = false, preview = false }: { change: FileChange; isError?: boolean; preview?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono fs-9.5 tracking-[0.14em] text-ink-900/55">{changeSectionLabel(c, isError)}</span>
      <ChangeView change={c} isError={isError} preview={preview} />
    </div>
  )
}

const meta = {
  title: 'Panels/DiffView',
  component: Labelled,
  args: { change: EDIT, isError: false, preview: false },
  render: (args) => (
    <div className="w-[450px] bg-panel p-4">
      <Labelled {...args} />
    </div>
  ),
} satisfies Meta<typeof Labelled>
export default meta

type Story = StoryObj<typeof meta>

/** An Edit: both sides known, a real diff. */
export const Edit: Story = {}

/** The permission card's proposed edit from the demo world: drawn as proposed. */
export const Proposed: Story = {
  args: { change: change('Edit', BILLING_DECISION.input), isError: true },
}

/** Applied to every occurrence. */
export const ReplaceAll: Story = {
  args: { change: change('Edit', { file_path: SENDER, old_string: 'post(', new_string: 'postSigned(', replace_all: true }) },
}

/** The arrived-open preview: the first hunk only, cut at its line budget. */
export const Preview: Story = {
  args: { change: change('Edit', { file_path: SENDER, old_string: BEFORE, new_string: LONG_AFTER }), preview: true },
}

/** An edit that changed nothing. */
export const Identical: Story = {
  args: { change: change('Edit', { file_path: SENDER, old_string: BEFORE, new_string: BEFORE }) },
}

/** Write: a new file is all additions; an overwrite and an unknown outcome say what Orbital does not have. */
export const Writes: Story = {
  render: () => {
    const input = { file_path: '/Users/demo/code/billing-api/src/retry.ts', content: AFTER }
    return (
      <div className="flex w-[450px] flex-col gap-5 bg-panel p-4">
        <Labelled change={change('Write', input, 'File created successfully at: src/retry.ts')} />
        <Labelled change={change('Write', input, 'The file src/retry.ts has been updated.')} />
        <Labelled change={change('Write', input, 'Permission denied', true)} isError />
      </div>
    )
  },
}

/** NotebookEdit: replace, insert, delete. */
export const Notebook: Story = {
  render: () => {
    const path = '/Users/demo/code/billing-api/notebooks/retries.ipynb'
    const source = 'import pandas as pd\nfailures = pd.read_csv("failures.csv")\nfailures.groupby("endpoint").size()'
    return (
      <div className="flex w-[450px] flex-col gap-5 bg-panel p-4">
        <Labelled change={change('NotebookEdit', { notebook_path: path, new_source: source, cell_id: 'c3' })} />
        <Labelled change={change('NotebookEdit', { notebook_path: path, new_source: source, edit_mode: 'insert', cell_id: 'c3' })} />
        <Labelled change={change('NotebookEdit', { notebook_path: path, new_source: '', edit_mode: 'delete', cell_id: 'c4' })} />
      </div>
    )
  },
}
