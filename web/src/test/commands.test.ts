import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCommand, dispatch, dispatchFromMenu, installKeyListener, handleKeyDown } from '../lib/commands'
import { useOrbital } from '../store/store'

function metaKeyEvent(overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...overrides,
  })
}

describe('useCommand / dispatch', () => {
  it('last registration wins; after the last one unmounts the earlier one runs again', () => {
    const first = vi.fn()
    const second = vi.fn()
    renderHook(() => useCommand('global.new-session', first))
    const later = renderHook(() => useCommand('global.new-session', second))

    expect(dispatch('global.new-session')).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()

    later.unmount()
    expect(dispatch('global.new-session')).toBe(true)
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('a registration with enabled: false is skipped, and updating enabled in place lets it run without re-ranking', () => {
    const below = vi.fn()
    const top = vi.fn()
    renderHook(() => useCommand('global.new-session', below, true))
    const { rerender } = renderHook(
      ({ enabled }) => useCommand('global.new-session', top, enabled),
      { initialProps: { enabled: false } },
    )

    expect(dispatch('global.new-session')).toBe(true)
    expect(below).toHaveBeenCalledTimes(1)
    expect(top).not.toHaveBeenCalled()

    rerender({ enabled: true })
    expect(dispatch('global.new-session')).toBe(true)
    expect(top).toHaveBeenCalledTimes(1)
    // Still on top of the stack, not re-pushed below `below` — a re-push on
    // the `enabled` toggle would have made `below` the winner again.
    expect(below).toHaveBeenCalledTimes(1)
  })

  it("dispatch('global.new-session') returns false with no registration; preventDefault is not called on the event then", () => {
    expect(dispatch('global.new-session')).toBe(false)

    const e = metaKeyEvent({ key: 'n', code: 'KeyN' })
    const spy = vi.spyOn(e, 'preventDefault')
    expect(handleKeyDown(e, { dialogOpen: () => false })).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('useCommand throws on an unknown id', () => {
    expect(() => renderHook(() => useCommand('nope', () => {}))).toThrow()
  })
})

describe('handleKeyDown', () => {
  it('runs the handler and prevents default for a meta+n event', () => {
    const handler = vi.fn()
    renderHook(() => useCommand('global.new-session', handler))

    const e = metaKeyEvent({ key: 'n', code: 'KeyN' })
    const spy = vi.spyOn(e, 'preventDefault')
    expect(handleKeyDown(e, { dialogOpen: () => false })).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('the typing guard: a !whileTyping command does not fire from a textarea, a whileTyping one does', () => {
    const endHandler = vi.fn()
    const newSessionHandler = vi.fn()
    renderHook(() => useCommand('session.end', endHandler))
    renderHook(() => useCommand('global.new-session', newSessionHandler))

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)

    const endEvent = metaKeyEvent({ key: 'Backspace', code: 'Backspace' })
    textarea.dispatchEvent(endEvent)
    expect(handleKeyDown(endEvent, { dialogOpen: () => false })).toBe(false)
    expect(endHandler).not.toHaveBeenCalled()

    const newSessionEvent = metaKeyEvent({ key: 'n', code: 'KeyN' })
    textarea.dispatchEvent(newSessionEvent)
    expect(handleKeyDown(newSessionEvent, { dialogOpen: () => false })).toBe(true)
    expect(newSessionHandler).toHaveBeenCalledTimes(1)

    document.body.removeChild(textarea)
  })

  it('the dialog rule: a non-global command does not fire while a dialog is open, a global one does', () => {
    const interruptHandler = vi.fn()
    const settingsHandler = vi.fn()
    renderHook(() => useCommand('session.interrupt', interruptHandler))
    renderHook(() => useCommand('global.settings', settingsHandler))

    const interruptEvent = metaKeyEvent({ key: '.', code: 'Period' })
    expect(handleKeyDown(interruptEvent, { dialogOpen: () => true })).toBe(false)
    expect(interruptHandler).not.toHaveBeenCalled()

    const settingsEvent = metaKeyEvent({ key: ',', code: 'Comma' })
    expect(handleKeyDown(settingsEvent, { dialogOpen: () => true })).toBe(true)
    expect(settingsHandler).toHaveBeenCalledTimes(1)
  })

  it('ignores an event that already has defaultPrevented set', () => {
    const handler = vi.fn()
    renderHook(() => useCommand('global.new-session', handler))

    const e = metaKeyEvent({ key: 'n', code: 'KeyN' })
    e.preventDefault()
    expect(handleKeyDown(e, { dialogOpen: () => false })).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('dispatchFromMenu', () => {
  it('applies the dialog rule: a session command stands down under a dialog, a global one runs', () => {
    const pin = vi.fn()
    const search = vi.fn()
    renderHook(() => useCommand('session.pin', pin))
    renderHook(() => useCommand('global.search', search))

    useOrbital.getState().setDialog('new')
    try {
      expect(dispatchFromMenu('session.pin')).toBe(false)
      expect(pin).not.toHaveBeenCalled()
      expect(dispatchFromMenu('global.search')).toBe(true)
      expect(search).toHaveBeenCalledTimes(1)
    } finally {
      useOrbital.getState().setDialog(null)
    }

    expect(dispatchFromMenu('session.pin')).toBe(true)
    expect(pin).toHaveBeenCalledTimes(1)
  })

  it('is false for an id the keymap does not know', () => {
    expect(dispatchFromMenu('global.nope')).toBe(false)
  })
})

describe('installKeyListener', () => {
  function fakeWindow() {
    return {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window
  }

  it('installing twice registers one listener; the uninstaller removes it', () => {
    const target = fakeWindow()

    const uninstallFirst = installKeyListener(target)
    installKeyListener(target)
    expect(target.addEventListener).toHaveBeenCalledTimes(1)
    expect(target.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function))

    uninstallFirst()
    expect(target.removeEventListener).toHaveBeenCalledTimes(1)
  })
})
