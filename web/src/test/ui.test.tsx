import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Panel } from '../ui/Panel'
import { Chip } from '../ui/Chip'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { StatusDot } from '../ui/StatusDot'
import { Dialog } from '../ui/Dialog'
import { Input, TextArea } from '../ui/Input'
import { Select } from '../ui/Select'
import type { SelectOption, SelectProps } from '../ui/Select'

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
    const { container } = render(<Panel side="left">content</Panel>)
    const el = container.firstElementChild as HTMLElement
    expect(el.className).toMatch(/from-\[rgba\(14,20,34/)
    // Docked panel edge is .16 in the export — brighter than the .14 hairline token.
    expect(el.className).toMatch(/border-\[rgba\(150,205,255,\.16\)\]/)
    expect(el.className).toMatch(/backdrop-blur/)
    expect(el.className).toMatch(/rounded/)
  })

  it('gives each side its own glass density (sidebar, detail panel, modal)', () => {
    const left = render(<Panel side="left">content</Panel>).container
      .firstElementChild as HTMLElement
    const right = render(<Panel side="right">content</Panel>).container
      .firstElementChild as HTMLElement
    const float = render(<Panel side="float">content</Panel>).container
      .firstElementChild as HTMLElement
    expect(left.className).toMatch(/from-\[rgba\(14,20,34,\.72\)\]/)
    expect(left.className).toMatch(/to-\[rgba\(8,12,22,\.78\)\]/)
    expect(right.className).toMatch(/from-\[rgba\(14,20,34,\.78\)\]/)
    expect(right.className).toMatch(/to-\[rgba\(8,12,22,\.84\)\]/)
    // The centred modal (1e/1h) is the densest: it covers a scrim, not the map.
    expect(float.className).toMatch(/from-\[rgba\(16,22,38,\.88\)\]/)
    expect(float.className).toMatch(/to-\[rgba\(8,12,22,\.94\)\]/)
    expect(float.className).toMatch(/backdrop-blur-\[28px\]/)
    expect(float.className).toMatch(/rounded-2xl/)
  })

  it('accepts a layout-only className passthrough without dropping internal styling', () => {
    const { container } = render(
      <Panel side="float" className="mt-4">
        content
      </Panel>,
    )
    const el = container.firstElementChild as HTMLElement
    expect(el.className).toMatch(/mt-4/)
    expect(el.className).toMatch(/from-\[rgba\(16,22,38/)
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

  it('keeps resting chips neutral (hue only in the dot); active chips get the hue-tinted border', () => {
    const { container, rerender } = render(<Chip label="work" hue={210} />)
    const root = container.firstElementChild as HTMLElement
    // Resting: no inline tint on the chip itself — the dot carries the hue.
    expect(root.getAttribute('style')).toBeNull()
    const dot = root.querySelector('span[aria-hidden]') as HTMLElement
    expect(dot.getAttribute('style')).toContain('210')

    rerender(<Chip label="work" hue={210} active />)
    expect(root.getAttribute('style') ?? '').toContain('210')
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

  // 1b tints only the border with the session's tag hue; the label stays the
  // fixed accent so a working badge reads the same whatever tag it belongs to.
  it('tints a working badge\'s border with the tag hue but keeps the label on the accent', () => {
    const { container } = render(<Badge variant="status" value="working" hue={60} />)
    const el = container.firstElementChild as HTMLElement
    // jsdom normalises the percentage lightness to a number.
    expect(el.style.borderColor).toBe('oklch(0.8 0.13 60 / 0.4)')
    expect(el.style.color).toBe('var(--color-accent)')
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

  it('renders a model badge', () => {
    render(<Badge variant="model" value="Opus 5 (1M)" />)
    const badge = screen.getByText('Opus 5 (1M)')
    expect(badge).toHaveAttribute('data-variant', 'model')
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

  // Queried off the dialog itself, not the render container: Dialog portals to
  // <body> so it escapes the backdrop-filtered panels it can be rendered from.
  it('renders four HUD corner brackets, portalled out of its mount point', () => {
    const { container } = render(
      <Dialog open title="New session" onClose={vi.fn()}>
        body
      </Dialog>,
    )
    expect(container).toBeEmptyDOMElement()
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelectorAll('[data-corner]')).toHaveLength(4)
    expect(dialog.closest('body')).toBe(document.body)
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

// ---------------------------------------------------------------------------
// Select — the custom listbox that replaced the native <select>
// ---------------------------------------------------------------------------

const FRUIT: Array<SelectOption<string>> = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
]

/** Controlled harness — the component never owns its value. */
function SelectHarness({
  onChange,
  initial = 'apple',
  ...rest
}: { onChange?: (v: string) => void; initial?: string } & Partial<
  Omit<SelectProps<string>, 'value' | 'onChange' | 'options'>
>) {
  const [value, setValue] = useState(initial)
  return (
    <div>
      <button type="button">before</button>
      <Select
        aria-label="Fruit"
        options={FRUIT}
        value={value}
        onChange={(v) => {
          setValue(v)
          onChange?.(v)
        }}
        {...rest}
      />
    </div>
  )
}

const trigger = () => screen.getByRole('combobox', { name: 'Fruit' })
const openFruit = () => fireEvent.click(trigger())

describe('Select', () => {
  it('is never a native select, and wires the closed combobox semantics', () => {
    const { container } = render(<SelectHarness />)

    expect(container.querySelector('select')).toBeNull()
    const el = trigger()
    expect(el.tagName).toBe('BUTTON')
    expect(el).toHaveAttribute('aria-expanded', 'false')
    expect(el).toHaveAttribute('aria-haspopup', 'listbox')
    expect(el).toHaveAttribute('aria-controls')
    expect(el).not.toHaveAttribute('aria-activedescendant')
    expect(el).toHaveTextContent('Apple')
    // The popup exists only while open.
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens on click into a listbox portalled to <body>, with one option per entry', () => {
    const { container } = render(<SelectHarness />)
    openFruit()

    const listbox = screen.getByRole('listbox')
    expect(listbox.id).toBe(trigger().getAttribute('aria-controls'))
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    // Portalled out of the render tree: a `backdrop-filter` panel would
    // otherwise trap it, and a scroll container would clip it.
    expect(container.contains(listbox)).toBe(false)
    expect(listbox.parentElement).toBe(document.body)

    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.getAttribute('data-label'))).toEqual(['Apple', 'Banana', 'Cherry'])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
    // Opening lands the active descendant on the selected row.
    expect(trigger()).toHaveAttribute('aria-activedescendant', options[0].id)
  })

  it('closes again when the trigger is clicked a second time', () => {
    render(<SelectHarness />)
    openFruit()
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.click(trigger())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(trigger()).toHaveFocus()
  })

  it('selects with the mouse, closes, and returns focus to the trigger', () => {
    const onChange = vi.fn()
    render(<SelectHarness onChange={onChange} />)

    openFruit()
    fireEvent.click(screen.getByRole('option', { name: 'Cherry' }))

    expect(onChange).toHaveBeenCalledWith('cherry')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(trigger()).toHaveTextContent('Cherry')
    expect(trigger()).toHaveFocus()
  })

  it('does not fire onChange when the already-selected option is re-picked', () => {
    const onChange = vi.fn()
    render(<SelectHarness onChange={onChange} />)

    openFruit()
    fireEvent.click(screen.getByRole('option', { name: 'Apple' }))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens with Enter, Space, ArrowDown and ArrowUp', () => {
    render(<SelectHarness />)

    for (const key of ['Enter', ' ', 'ArrowDown']) {
      fireEvent.keyDown(trigger(), { key })
      expect(screen.getByRole('listbox')).toBeInTheDocument()
      fireEvent.keyDown(trigger(), { key: 'Escape' })
    }

    // ArrowUp opens onto the LAST option, the way a closed select would.
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' })
    expect(trigger()).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Cherry' }).id
    )
  })

  it('moves the active option with the arrows and commits with Enter', () => {
    const onChange = vi.fn()
    render(<SelectHarness onChange={onChange} />)

    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    expect(trigger()).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Banana' }).id
    )
    // Arrowing alone must not commit anything.
    expect(onChange).not.toHaveBeenCalled()
    // …and DOM focus never leaves the trigger.
    expect(document.activeElement === document.body || document.activeElement === trigger()).toBe(true)

    fireEvent.keyDown(trigger(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('banana')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(trigger()).toHaveFocus()
  })

  it('commits with Space as well', () => {
    const onChange = vi.fn()
    render(<SelectHarness onChange={onChange} />)

    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    fireEvent.keyDown(trigger(), { key: ' ' })
    expect(onChange).toHaveBeenCalledWith('banana')
  })

  it('clamps the arrows at both ends and jumps with Home/End', () => {
    render(<SelectHarness initial="banana" />)
    const id = (name: string) => screen.getByRole('option', { name }).id

    openFruit()
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' })
    fireEvent.keyDown(trigger(), { key: 'ArrowUp' })
    expect(trigger()).toHaveAttribute('aria-activedescendant', id('Apple'))

    fireEvent.keyDown(trigger(), { key: 'End' })
    expect(trigger()).toHaveAttribute('aria-activedescendant', id('Cherry'))
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    expect(trigger()).toHaveAttribute('aria-activedescendant', id('Cherry'))

    fireEvent.keyDown(trigger(), { key: 'Home' })
    expect(trigger()).toHaveAttribute('aria-activedescendant', id('Apple'))
  })

  it('moves the active option by type-ahead', () => {
    const onChange = vi.fn()
    render(<SelectHarness onChange={onChange} />)

    openFruit()
    fireEvent.keyDown(trigger(), { key: 'c' })
    expect(trigger()).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Cherry' }).id
    )

    fireEvent.keyDown(trigger(), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('cherry')
  })

  it('opens on a printable key and lands on the match', () => {
    render(<SelectHarness />)

    fireEvent.keyDown(trigger(), { key: 'b' })
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(trigger()).toHaveAttribute(
      'aria-activedescendant',
      screen.getByRole('option', { name: 'Banana' }).id
    )
  })

  it('restores the previous value and the focus on Escape', () => {
    const onChange = vi.fn()
    render(<SelectHarness onChange={onChange} />)

    openFruit()
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    fireEvent.keyDown(trigger(), { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    expect(trigger()).toHaveTextContent('Apple')
    expect(trigger()).toHaveFocus()
  })

  it('closes on Tab without committing, so focus can move on', () => {
    const onChange = vi.fn()
    render(<SelectHarness onChange={onChange} />)

    openFruit()
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    fireEvent.keyDown(trigger(), { key: 'Tab' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closes on an outside pointerdown, and ignores pointerdowns inside itself', () => {
    render(<SelectHarness />)

    openFruit()
    fireEvent.pointerDown(screen.getByRole('option', { name: 'Banana' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.pointerDown(screen.getByRole('button', { name: 'before' }))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('renders disabled as a real disabled control that cannot be opened', () => {
    render(<SelectHarness disabled />)

    expect(trigger()).toBeDisabled()
    fireEvent.click(trigger())
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('carries the option dot into the trigger and tints the pill border with it', () => {
    render(
      <Select
        variant="pill"
        aria-label="Tag"
        options={[
          { value: 1, label: 'work', dotColor: 'oklch(80% 0.13 210)' },
          { value: 2, label: 'default', dotColor: 'oklch(80% 0.13 60)' },
        ]}
        value={2}
        onChange={vi.fn()}
      />
    )

    const el = screen.getByRole('combobox', { name: 'Tag' })
    expect(el).toHaveAttribute('data-variant', 'pill')
    // 1e's pill border is the selected tag's hue at .4 — `color-mix` with
    // transparent is premultiplied, so 40% of the hue IS that hue at alpha .4.
    expect(el.style.borderColor).toMatch(/color-mix\(in oklab, oklch\(0?\.?8.* 40%, transparent\)/)
    expect(el.querySelector('span[aria-hidden]')).toHaveStyle({ background: 'oklch(80% 0.13 60)' })
  })

  it('is generic over the value type — numeric values round-trip without casts', () => {
    const onChange = vi.fn<(value: number) => void>()
    render(
      <Select
        aria-label="Tag"
        options={[
          { value: 1, label: 'work' },
          { value: 2, label: 'default' },
        ]}
        value={1}
        onChange={onChange}
      />
    )

    fireEvent.click(screen.getByRole('combobox', { name: 'Tag' }))
    fireEvent.click(screen.getByRole('option', { name: 'default' }))
    expect(onChange).toHaveBeenCalledWith(2)
  })
})
