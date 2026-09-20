import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Chip } from '../ui/Chip'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Select } from '../ui/Select'
import type { SelectOption, SelectProps } from '../ui/Select'

describe('Chip', () => {
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

describe('Button', () => {
  it('renders a real <button> element', () => {
    render(<Button>Launch</Button>)
    expect(screen.getByRole('button', { name: 'Launch' }).tagName).toBe('BUTTON')
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
    // The listbox sits inside the popup's chrome (which also carries the
    // optional footer), and that chrome is the direct child of <body>.
    expect(listbox.parentElement?.parentElement).toBe(document.body)

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

  it('describes the tag trigger with the popup footer instead of faking an option', () => {
    render(
      <Select
        variant="tag"
        aria-label="Change tag"
        options={[{ value: 1, label: 'work' }]}
        value={1}
        onChange={vi.fn()}
        footer="ONE TAG PER SESSION"
      />
    )

    const el = screen.getByRole('combobox', { name: 'Change tag' })
    expect(el).not.toHaveAttribute('aria-describedby')

    fireEvent.click(el)
    const hint = screen.getByText('ONE TAG PER SESSION')
    expect(el.getAttribute('aria-describedby')).toBe(hint.id)
    // It is a description of the control, not something the user can pick.
    expect(screen.getAllByRole('option')).toHaveLength(1)
  })

  // 3a: the menu spells the option out, the trigger keeps the short form.
  it('prefers an option short label on the trigger, while the menu keeps the long one', () => {
    render(
      <Select
        aria-label="Origin"
        options={[
          { value: 'all', label: 'all sessions', short: 'all' },
          { value: 'terminal', label: 'other terminals · read-only', short: 'read-only' },
        ]}
        value="terminal"
        onChange={vi.fn()}
      />
    )

    const el = screen.getByRole('combobox', { name: 'Origin' })
    expect(el.textContent?.replace('▾', '').trim()).toBe('read-only')

    fireEvent.click(el)
    expect(screen.getByRole('option', { name: /other terminals · read-only/ })).toBeInTheDocument()
  })

  // 3a hangs the origin menu off the trigger's right edge. The trigger lives
  // at the right end of a 300px panel, so a menu aligned to its LEFT edge
  // would spill out of the sidebar and onto the map.
  it('right-aligns the ghost popup to its trigger', () => {
    render(<SelectHarness variant="ghost" />)

    const el = trigger()
    fireEvent.click(el)
    const popup = screen.getByRole('listbox', { name: 'Fruit' }).parentElement!

    // jsdom has no layout, so the geometry has to be supplied.
    el.getBoundingClientRect = () =>
      ({ left: 240, right: 280, top: 100, bottom: 120, width: 40, height: 20 }) as DOMRect
    Object.defineProperty(popup, 'offsetWidth', { value: 186, configurable: true })
    fireEvent(window, new Event('resize'))

    expect(popup.style.left).toBe('94px')
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
