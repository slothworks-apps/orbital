import type { Meta, StoryObj } from '@storybook/react-vite'
import { Unauthorized } from './Unauthorized'

const meta = {
  title: 'UI/Unauthorized',
  component: Unauthorized,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Unauthorized>
export default meta

type Story = StoryObj<typeof meta>

/** A browser tab opened without the server's link. It has no props; the terminal line uses the page's own origin. */
export const Default: Story = {}
