import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ReleaseNotes } from '@orbital/shared/changelog'
import { ReleaseNoteSections, ReleaseNoteVersions } from './ReleaseNotes'

const V046: ReleaseNotes = {
  version: '0.46.0',
  date: '2026-11-04',
  sections: [
    {
      title: 'NEW',
      items: [
        'The media viewer shows a PDF page by page, with a rail to jump between pages.',
        'Images fill the window, centred, with the caption on the filmstrip.',
      ],
    },
    { title: 'CHANGED', items: ["What's new spans every version you skipped, not only the last."] },
    { title: 'FIXED', items: ['Planets keep their tag colour after a restart.'] },
  ],
}

const V045: ReleaseNotes = {
  version: '0.45.1',
  date: '2026-10-28',
  sections: [{ title: 'FIXED', items: ['A press in the page rail no longer closes the viewer.'] }],
}

const V045_0: ReleaseNotes = {
  version: '0.45.0',
  sections: [{ title: 'NEW', items: ['Sessions can be opened in a window of their own.'] }],
}

const meta = {
  title: 'UI/ReleaseNotes',
  component: ReleaseNoteSections,
  args: { sections: V046.sections, heading: 'h3' },
  render: (args) => (
    <div className="flex w-[480px] flex-col gap-5">
      <ReleaseNoteSections {...args} />
    </div>
  ),
} satisfies Meta<typeof ReleaseNoteSections>
export default meta

type Story = StoryObj<typeof meta>

/** One version's sections, as WHAT'S NEW draws them. */
export const Playground: Story = {}

/** `ReleaseNoteVersions` with one version: its sections alone. */
export const OneVersion: Story = {
  render: () => (
    <div className="flex w-[480px] flex-col gap-5">
      <ReleaseNoteVersions notes={[V046]} gap="gap-5" ruled="pt-5" />
    </div>
  ),
}

/** After skipping versions: each under its number and date (the last has none), ruled off from the one before. */
export const SkippedVersions: Story = {
  render: () => (
    <div className="flex w-[480px] flex-col gap-5">
      <ReleaseNoteVersions notes={[V046, V045, V045_0]} gap="gap-5" ruled="pt-5" />
    </div>
  ),
}
