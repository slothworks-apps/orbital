/**
 * The dispatcher (spec: 2026-09-23-shortcuts-design § 4): the registry every
 * scope-owning component pushes its handler onto, and the one `keydown`
 * listener that turns a keymap chord into a dispatch, or lets the key fall
 * through.
 *
 * Mirrors `ui/escapeLayer.tsx` on purpose — a module-level stack, the latest
 * registration winning, the handler held in a ref so a changing closure
 * identity never re-registers it. The difference is shape, not idea: Escape
 * has exactly one stack because it is one key with one meaning at a time;
 * this module keeps one stack per command id, because two different commands
 * are routinely live at once — a selected session's `session.pin` next to
 * the sidebar's `global.search`.
 */

import { useEffect, useRef } from 'react'
import { COMMANDS, command, isTypingTarget, matches } from './keymap'
import { useOrbital } from '../store/store'

interface Registration {
  handler: () => void
  enabled: boolean
}

/** One stack per command id; `useCommand` pushes on mount, pops on unmount. */
const registry = new Map<string, Registration[]>()

/**
 * Registers `handler` under `id` for as long as the calling component stays
 * mounted, with the latest registration for an id winning `dispatch`.
 * `command(id)` validates `id` on every render, so a typo throws at the call
 * site rather than silently never firing.
 */
export function useCommand(id: string, handler: () => void, enabled = true): void {
  command(id)

  // A changing `handler` identity must never re-register — that would move
  // this registration to the top of its stack on every render.
  const latest = useRef(handler)
  latest.current = handler

  const registration = useRef<Registration | null>(null)

  useEffect(() => {
    const reg: Registration = { handler: () => latest.current(), enabled }
    registration.current = reg
    const stack = registry.get(id)
    if (stack) stack.push(reg)
    else registry.set(id, [reg])
    return () => {
      const s = registry.get(id)
      if (!s) return
      const i = s.indexOf(reg)
      if (i !== -1) s.splice(i, 1)
      if (s.length === 0) registry.delete(id)
      registration.current = null
    }
    // `enabled` is applied by the effect below, in place on the existing
    // registration, precisely so toggling it never re-runs this effect and
    // re-ranks the registration among its peers for the same id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (registration.current) registration.current.enabled = enabled
  }, [enabled])
}

/**
 * Runs the top enabled handler registered for `id`. Besides the listener
 * below, this is also the desktop bridge's entry point (later work): the
 * Electron menu sends command ids, and `dispatch` is what turns one into a
 * running handler.
 */
export function dispatch(id: string): boolean {
  const stack = registry.get(id)
  if (!stack) return false
  for (let i = stack.length - 1; i >= 0; i--) {
    const reg = stack[i]
    if (reg.enabled) {
      reg.handler()
      return true
    }
  }
  return false
}

/**
 * A desktop menu item, or its accelerator, run in this window (spec:
 * 2026-09-23-shortcuts-design § 5). The key path's dialog rule applies here
 * too, because the menu is where a key goes when the listener below refused
 * it without `preventDefault`: while a dialog is open only the global
 * commands run, so ⌘P does not pin a session behind the New session dialog.
 * The typing guard has no equivalent — main never claims those keys. An id
 * the keymap does not know is false rather than a throw: it came over IPC.
 */
export function dispatchFromMenu(id: string): boolean {
  const cmd = COMMANDS.find((c) => c.id === id)
  if (!cmd) return false
  if (cmd.scope !== 'global' && useOrbital.getState().ui.dialog !== null) return false
  return dispatch(id)
}

/**
 * Turns one keydown into a command dispatch, or returns false and leaves the
 * event alone. Exported directly (rather than only reachable through the
 * listener) so tests can drive it with a synthetic event and a fake
 * `dialogOpen`, without a real listener or a real dialog in the store.
 */
export function handleKeyDown(e: KeyboardEvent, deps: { dialogOpen: () => boolean }): boolean {
  if (e.defaultPrevented) return false

  const cmd = COMMANDS.find((c) => !c.local && c.chords.some((chord) => matches(chord, e)))
  if (!cmd) return false

  // The field keeps the key: a shortcut that isn't meant to fire while
  // typing falls through rather than stealing the keystroke from an input.
  if (!cmd.whileTyping && isTypingTarget(e.target)) return false

  // A dialog or a question card owns the keyboard except for the commands
  // that reach anywhere in the app.
  if (deps.dialogOpen() && cmd.scope !== 'global') return false

  if (!dispatch(cmd.id)) return false
  e.preventDefault()
  return true
}

/** Set while a listener from `installKeyListener` is active; guards the no-op-on-double-install rule. */
let installedTarget: Window | null = null
let installedListener: ((e: KeyboardEvent) => void) | null = null

/**
 * The app's one keydown listener, added in the bubble phase — the escape
 * layer owns the capture phase for Escape, and bubble phase is what lets a
 * control that handled a key and called `preventDefault` keep it, since
 * `handleKeyDown` never runs on an event that already has `defaultPrevented`
 * set.
 *
 * Installing twice is a no-op: `main.tsx` calls this once at module level,
 * ahead of the branch that decides which of the app's several entry points
 * (main window, detached session window, …) actually mounts, and either
 * mounting again on a hot update must not add a second listener.
 */
export function installKeyListener(target: Window = window): () => void {
  if (installedTarget) return () => {}

  const onKeyDown = (e: KeyboardEvent) => {
    handleKeyDown(e, { dialogOpen: () => useOrbital.getState().ui.dialog !== null })
  }
  target.addEventListener('keydown', onKeyDown)
  installedTarget = target
  installedListener = onKeyDown

  return () => {
    if (installedListener) target.removeEventListener('keydown', installedListener)
    installedTarget = null
    installedListener = null
  }
}
