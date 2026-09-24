import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MENU_SEPARATOR, MenuButton } from '../ui/Menu'
import type { MenuEntry } from '../ui/Menu'

function setup(overrides: { disabledFirst?: boolean } = {}) {
  const stats = vi.fn()
  const clear = vi.fn()
  const detach = vi.fn()
  const entries: MenuEntry[] = [
    { key: 'stats', label: 'Session stats', onSelect: stats, disabled: overrides.disabledFirst },
    { key: 'clear', label: 'Clear and start over', onSelect: clear },
    MENU_SEPARATOR,
    { key: 'detach', label: 'Open in new window', onSelect: detach },
  ]
  const onOpenChange = vi.fn()
  render(
    <>
      <MenuButton
        aria-label="More"
        entries={entries}
        onOpenChange={onOpenChange}
        renderTrigger={(props) => (
          <button type="button" aria-label="More" {...props}>
            ⋯
          </button>
        )}
      />
      <button type="button">Elsewhere</button>
    </>,
  )
  const trigger = screen.getByRole('button', { name: 'More' })
  return { trigger, stats, clear, detach, onOpenChange }
}

const focusedLabel = () => document.activeElement?.textContent

describe('MenuButton', () => {
  it('opens from the keyboard onto the first row, and from ArrowUp onto the last', () => {
    const { trigger } = setup()
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.getByRole('menu', { name: 'More' })).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(focusedLabel()).toBe('Session stats')

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    fireEvent.keyDown(trigger, { key: 'ArrowUp' })
    expect(focusedLabel()).toBe('Open in new window')
  })

  it('moves with the arrows, wraps, and jumps with Home/End — never onto the hairline', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)
    expect(screen.getByRole('separator')).toBeInTheDocument()

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focusedLabel()).toBe('Clear and start over')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focusedLabel()).toBe('Open in new window')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(focusedLabel()).toBe('Session stats')
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(focusedLabel()).toBe('Open in new window')
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(focusedLabel()).toBe('Session stats')
    fireEvent.keyDown(menu, { key: 'End' })
    expect(focusedLabel()).toBe('Open in new window')
  })

  it('jumps to a row by its first letter', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'o' })
    expect(focusedLabel()).toBe('Open in new window')
  })

  it('runs the row on Enter, closes, and hands focus back to the trigger', () => {
    const { trigger, clear } = setup()
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    fireEvent.keyDown(menu, { key: 'Enter' })
    expect(clear).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('runs a row on click', () => {
    const { trigger, detach } = setup()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in new window' }))
    expect(detach).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('leaves a disabled row in place but does nothing with it', () => {
    const { trigger, stats } = setup({ disabledFirst: true })
    fireEvent.click(trigger)
    const row = screen.getByRole('menuitem', { name: 'Session stats' })
    expect(row).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' })
    expect(stats).not.toHaveBeenCalled()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('closes on Escape and on Tab, back to the trigger', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on a press outside it, and tells its owner each time', () => {
    const { trigger, onOpenChange } = setup()
    fireEvent.click(trigger)
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('toggles closed from its own trigger', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  describe('group headings, the selected mark, custom row bodies and the row ceiling', () => {
    function setupGrouped(maxRows?: number) {
      const run = vi.fn()
      const done = vi.fn()
      const entries: MenuEntry[] = [
        { heading: 'Running · 2' },
        { key: 'a', label: 'Alpha task', onSelect: run },
        { key: 'b', label: 'Beta task', onSelect: run, selected: true },
        { heading: 'Done · 2' },
        { key: 'c', label: 'Crunch numbers', body: <span>custom body C</span>, onSelect: done, selected: false },
        { key: 'd', label: 'Delta task', onSelect: done },
      ]
      render(
        <MenuButton
          aria-label="Subagents"
          entries={entries}
          maxRows={maxRows}
          renderTrigger={(props) => (
            <button type="button" aria-label="Subagents" {...props}>
              agents
            </button>
          )}
        />,
      )
      const trigger = screen.getByRole('button', { name: 'Subagents' })
      return { trigger, run, done }
    }

    /** A body row's text is its body, so name the focused row the way a screen reader would. */
    const focusedName = () => document.activeElement?.getAttribute('aria-label') ?? focusedLabel()?.replace('✓', '')

    // jsdom has no scrollIntoView; the ceiling test lends it one.
    const jsdomScrollIntoView = Element.prototype.scrollIntoView
    afterEach(() => {
      vi.restoreAllMocks()
      Element.prototype.scrollIntoView = jsdomScrollIntoView
    })

    it('skips headings with the arrows, Home and End, and does not count them as items', () => {
      const { trigger } = setupGrouped()
      fireEvent.keyDown(trigger, { key: 'Enter' })
      const menu = screen.getByRole('menu')
      expect(screen.getAllByRole('menuitem')).toHaveLength(4)
      expect(focusedName()).toBe('Alpha task')

      fireEvent.keyDown(menu, { key: 'ArrowDown' })
      expect(focusedName()).toBe('Beta task')
      fireEvent.keyDown(menu, { key: 'ArrowDown' })
      expect(focusedName()).toBe('Crunch numbers')
      fireEvent.keyDown(menu, { key: 'ArrowUp' })
      expect(focusedName()).toBe('Beta task')
      fireEvent.keyDown(menu, { key: 'End' })
      expect(focusedName()).toBe('Delta task')
      fireEvent.keyDown(menu, { key: 'Home' })
      expect(focusedName()).toBe('Alpha task')
      // Wrapping up from the first item passes over the heading above it.
      fireEvent.keyDown(menu, { key: 'ArrowUp' })
      expect(focusedName()).toBe('Delta task')
    })

    it('leaves headings out of type-ahead', () => {
      const { trigger } = setupGrouped()
      fireEvent.click(trigger)
      // "d" would match the "Done · 2" heading first, but only items are candidates.
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'd' })
      expect(focusedName()).toBe('Delta task')
    })

    it('marks the selected row, and only that one, with aria-current', () => {
      const { trigger } = setupGrouped()
      fireEvent.click(trigger)
      const current = screen.getAllByRole('menuitem').filter((row) => row.getAttribute('aria-current') === 'true')
      expect(current).toHaveLength(1)
      expect(current[0]).toHaveAccessibleName('Beta task')
    })

    it('draws a custom body, named by its label, reachable by type-ahead and run on Enter', () => {
      const { trigger, done } = setupGrouped()
      fireEvent.click(trigger)
      const row = screen.getByRole('menuitem', { name: 'Crunch numbers' })
      expect(row).toHaveTextContent('custom body C')

      fireEvent.keyDown(screen.getByRole('menu'), { key: 'c' })
      expect(document.activeElement).toBe(row)
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' })
      expect(done).toHaveBeenCalledOnce()
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    })

    it('caps its height under maxRows and scrolls the focused row into view', () => {
      // jsdom does no layout: give every element a height and a position so
      // the ceiling has something to measure.
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(10)
      vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockReturnValue(10)
      const scrollIntoView = vi.fn()
      Element.prototype.scrollIntoView = scrollIntoView

      const { trigger } = setupGrouped(2)
      fireEvent.click(trigger)
      const menu = screen.getByRole('menu')
      expect(menu.style.maxHeight).not.toBe('')

      fireEvent.keyDown(menu, { key: 'End' })
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
      expect(scrollIntoView.mock.instances.at(-1)).toBe(document.activeElement)
    })

    it('keeps focus on the focused row when the list reorders under it', () => {
      const entries = (bInDone: boolean): MenuEntry[] => [
        { heading: 'Running' },
        { key: 'a', label: 'Alpha task', onSelect: () => {} },
        ...(bInDone ? [] : [{ key: 'b', label: 'Beta task', onSelect: () => {} }]),
        { heading: 'Done' },
        ...(bInDone ? [{ key: 'b', label: 'Beta task', onSelect: () => {} }] : []),
        { key: 'c', label: 'Crunch numbers', onSelect: () => {} },
      ]
      const menu = (bInDone: boolean) => (
        <MenuButton
          aria-label="Subagents"
          entries={entries(bInDone)}
          renderTrigger={(props) => (
            <button type="button" aria-label="Subagents" {...props}>
              agents
            </button>
          )}
        />
      )
      const { rerender } = render(menu(false))
      fireEvent.click(screen.getByRole('button', { name: 'Subagents' }))
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
      expect(focusedName()).toBe('Beta task')

      // Chromium blurs a focused node React moves with insertBefore; jsdom
      // does not, so drop focus to <body> the way Chromium would.
      ;(document.activeElement as HTMLElement).blur()
      expect(document.activeElement).toBe(document.body)
      rerender(menu(true))
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Beta task' }))

      // Arrows go on from there, in the new order.
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
      expect(focusedName()).toBe('Crunch numbers')
    })

    it('sets no ceiling without maxRows', () => {
      const { trigger } = setupGrouped()
      fireEvent.click(trigger)
      expect(screen.getByRole('menu').style.maxHeight).toBe('')
    })
  })
})
