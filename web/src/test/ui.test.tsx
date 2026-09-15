import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Panel } from '../ui/Panel'
import { Chip } from '../ui/Chip'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { StatusDot } from '../ui/StatusDot'
import { Dialog } from '../ui/Dialog'
import { Input, TextArea } from '../ui/Input'

describe('Panel', () => {
  it('renders children and a side data-attribute per side variant', () => {
    const { container, rerender } = render(<Panel side="left">left content</Panel>)
    expect(screen.getByText('left content')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveAttribute('data-side', 'left')

    rerender(<Panel side="right">right content</Panel>)
    expect(container.firstElementChild).toHaveAttribute('data-side', 'right')

    rerender(<Panel side="float">float content</Panel>)
    expect(container.firstElementChild).toHaveAttribute('data-side', 'float')
  })

  it('reflects collapsed state via data-attribute', () => {
    const { container, rerender } = render(<Panel side="left">content</Panel>)
    expect(container.firstElementChild).toHaveAttribute('data-collapsed', 'false')

    rerender(
      <Panel side="left" collapsed>
        content
      </Panel>,
    )
    expect(container.firstElementChild).toHaveAttribute('data-collapsed', 'true')
  })

  it('applies the glass styling classes (panel bg, border, blur, rounded)', () => {
    const { container } = render(<Panel side="float">content</Panel>)
    const el = container.firstElementChild as HTMLElement
    expect(el.className).toMatch(/from-\[rgba\(14,20,34/)
    expect(el.className).toMatch(/border-panel-border/)
    expect(el.className).toMatch(/backdrop-blur/)
    expect(el.className).toMatch(/rounded/)
  })

  it('accepts a layout-only className passthrough without dropping internal styling', () => {
    const { container } = render(
      <Panel side="float" className="mt-4">
        content
      </Panel>,
    )
    const el = container.firstElementChild as HTMLElement
    expect(el.className).toMatch(/mt-4/)
    expect(el.className).toMatch(/from-\[rgba\(14,20,34/)
  })
})

describe('Chip', () => {
  it('renders the label', () => {
    render(<Chip label="work" />)
    expect(screen.getByText('work')).toBeInTheDocument()
  })

  it('marks active state via data-active', () => {
    const { rerender } = render(<Chip label="work" active />)
    expect(screen.getByText('work').closest('[data-active]')).toHaveAttribute('data-active', 'true')

    rerender(<Chip label="work" active={false} />)
    expect(screen.getByText('work').closest('[data-active]')).toHaveAttribute('data-active', 'false')
  })

  it('tints border/dot via tagColor(hue) inline style', () => {
    const { container } = render(<Chip label="work" hue={210} />)
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveStyle('border-color: oklch(80% 0.13 210)')
  })

  it('fires onClick when clicked and exposes a button role', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<Chip label="work" onClick={onClick} />)
    await user.click(screen.getByRole('button', { name: /work/i }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('fires onRemove without triggering onClick', async () => {
    const onClick = vi.fn()
    const onRemove = vi.fn()
    const user = userEvent.setup()
    render(<Chip label="work" onClick={onClick} onRemove={onRemove} />)
    await user.click(screen.getByRole('button', { name: /remove work/i }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('Badge', () => {
  it.each([
    ['working', 'WORKING'],
    ['needs_input', 'NEEDS INPUT'],
    ['idle', 'IDLE'],
    ['ended', 'ENDED'],
  ] as const)('maps status %s to label + data-status', (status, label) => {
    const { container } = render(<Badge variant="status" value={status} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(container.firstElementChild).toHaveAttribute('data-status', status)
    expect(container.firstElementChild).toHaveAttribute('data-variant', 'status')
  })

  it('gives the working status a pulse animation class', () => {
    const { container } = render(<Badge variant="status" value="working" />)
    expect(container.innerHTML).toMatch(/orbital-pulse/)
  })

  it('gives the needs_input status a white accent', () => {
    const { container } = render(<Badge variant="status" value="needs_input" />)
    const el = container.firstElementChild as HTMLElement
    expect(el.className).toMatch(/white/)
  })

  it('renders a permission-mode badge', () => {
    render(<Badge variant="mode" value="acceptEdits" />)
    expect(screen.getByText('acceptEdits')).toBeInTheDocument()
  })

  it('renders a count badge with optional label', () => {
    render(<Badge variant="count" value={12} label="sessions" />)
    expect(screen.getByText(/12/)).toBeInTheDocument()
    expect(screen.getByText(/sessions/)).toBeInTheDocument()
  })
})

describe('Button', () => {
  it('renders a real <button> element', () => {
    render(<Button>Launch</Button>)
    expect(screen.getByRole('button', { name: 'Launch' }).tagName).toBe('BUTTON')
  })

  it.each(['primary', 'ghost', 'danger'] as const)('exposes variant %s via data-variant', (variant) => {
    render(<Button variant={variant}>go</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', variant)
  })

  it.each(['sm', 'md'] as const)('exposes size %s via data-size', (size) => {
    render(<Button size={size}>go</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('data-size', size)
  })

  it('fires onClick', async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<Button onClick={onClick}>go</Button>)
    await user.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('defaults to type="button" so it never submits a form by accident', () => {
    render(<Button>go</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
  })
})

describe('StatusDot', () => {
  it.each(['working', 'needs_input', 'idle', 'ended'] as const)(
    'reflects status %s via data-status',
    (status) => {
      const { container } = render(<StatusDot status={status} />)
      expect(container.firstElementChild).toHaveAttribute('data-status', status)
    },
  )

  it('pulses when working', () => {
    const { container } = render(<StatusDot status="working" />)
    expect((container.firstElementChild as HTMLElement).className).toMatch(/orbital-pulse/)
  })

  it('dims with an outline when ended', () => {
    const { container } = render(<StatusDot status="ended" />)
    expect((container.firstElementChild as HTMLElement).className).toMatch(/opacity-40/)
  })

  it('tints via tagColor(hue) without changing on status', () => {
    const { container } = render(<StatusDot status="idle" hue={210} />)
    expect(container.firstElementChild).toHaveStyle('background: oklch(80% 0.13 210)')
  })
})

describe('Dialog', () => {
  it('renders nothing when closed', () => {
    render(
      <Dialog open={false} title="New session" onClose={vi.fn()}>
        body
      </Dialog>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders title, children, and footer when open, with dialog a11y attrs', () => {
    render(
      <Dialog open title="New session" onClose={vi.fn()} footer={<button>Launch</button>}>
        body content
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(screen.getByText('New session')).toBeInTheDocument()
    expect(screen.getByText('body content')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Launch' })).toBeInTheDocument()
  })

  it('renders four HUD corner brackets', () => {
    const { container } = render(
      <Dialog open title="New session" onClose={vi.fn()}>
        body
      </Dialog>,
    )
    expect(container.querySelectorAll('[data-corner]')).toHaveLength(4)
  })

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(
      <Dialog open title="New session" onClose={onClose}>
        body
      </Dialog>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not listen for Escape when closed', () => {
    const onClose = vi.fn()
    render(
      <Dialog open={false} title="New session" onClose={onClose}>
        body
      </Dialog>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Input / TextArea', () => {
  it('defaults to sans font', () => {
    render(<Input placeholder="search" />)
    expect(screen.getByPlaceholderText('search')).toHaveAttribute('data-font', 'sans')
  })

  it('switches to mono font via the font prop', () => {
    render(<Input placeholder="cwd" font="mono" />)
    const el = screen.getByPlaceholderText('cwd')
    expect(el).toHaveAttribute('data-font', 'mono')
    expect(el.className).toMatch(/font-mono/)
  })

  it('accepts standard input props and forwards user input', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Input placeholder="search" onChange={onChange} />)
    await user.type(screen.getByPlaceholderText('search'), 'hi')
    expect(onChange).toHaveBeenCalled()
  })

  it('renders a TextArea with the mono font variant', () => {
    render(<TextArea placeholder="prompt" font="mono" />)
    const el = screen.getByPlaceholderText('prompt')
    expect(el.tagName).toBe('TEXTAREA')
    expect(el).toHaveAttribute('data-font', 'mono')
  })
})
