import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useCommand } from '../lib/commands'
import { onTerminalKey } from '../lib/desktop'
import { terminalCursor, terminalCursorBlink, terminalEnabled, type TerminalPlacement } from '../lib/experimental'
import { useOrbital } from '../store/store'
import { agentSlotOpen, placementIn, runTerminalChord, toggleTerminalFromKey } from './actions'
import { parseTerminalChord } from './keys'
import { sideSlotWidth } from './layout'
import { useTerminals } from './store'

/** Main's terminal chords are heard once per page, whichever window mounts first. */
let listeningForChords = false
/** Whether xterm has been asked for yet, so a window that never shows a terminal never loads it. */
let runtimeLoaded = false

/**
 * What a window needs to show its session's terminal: whether it is on, where
 * it sits, and whether it is on screen now. With the switch off every answer
 * is "nothing", so the window looks as it does without the feature.
 */
export function useTerminalPlacement(sessionId: string | null): {
  enabled: boolean
  placement: TerminalPlacement
  /** Shown and holding at least one tab — what the dock or side panel draws. */
  shown: boolean
  /** Shown and on screen: in the dock, or in the side slot with no agent's panel in it. */
  onScreen: boolean
  /** The side panel is in the slot: shown, in the side placement, and no agent's panel took the slot. */
  sideOnScreen: boolean
} {
  const enabled = useOrbital((s) => terminalEnabled(s.settings))
  const placement = useOrbital((s) => placementIn(s.settings))
  const agentOpen = useOrbital(agentSlotOpen)
  const shown = useTerminals(
    (s) => sessionId !== null && Boolean(s.shown[sessionId]) && (s.tabs[sessionId] ?? []).length > 0,
  )
  const on = enabled && shown
  const sideOnScreen = on && placement === 'side' && !agentOpen
  return { enabled, placement, shown: on, onScreen: placement === 'side' ? sideOnScreen : on, sideOnScreen }
}

/**
 * The terminal's lifecycle in a window (spec 2026-10-05-embedded-terminal-design
 * § Web), for the session the window shows:
 *
 * - opening a session loads its terminals from the server and attaches to
 *   them; leaving it lets go of the sockets, never of the shells;
 * - ⌃` toggles the terminal, and the chords main catches while a terminal has
 *   focus (⌘T, ⌘W, ⌘1–9) land here;
 * - in the main window, the sidebar folds to its rail while the side panel
 *   holds the slot, and comes back as it was (48b).
 *
 * Off behind its switch, it attaches to nothing; running shells go on running
 * and are there again when it is turned back on.
 */
export function useTerminalHost(sessionId: string | null, opts: { mainWindow: boolean }): void {
  const enabled = useOrbital((s) => terminalEnabled(s.settings))
  const cursor = useOrbital((s) => terminalCursor(s.settings))
  const blink = useOrbital((s) => terminalCursorBlink(s.settings))
  const tabIds = useTerminals(useShallow((s) => (sessionId ? (s.tabs[sessionId] ?? []).map((t) => t.id) : [])))
  const { sideOnScreen } = useTerminalPlacement(sessionId)

  useEffect(() => {
    if (!enabled || !sessionId) return
    void useTerminals.getState().load(sessionId)
  }, [enabled, sessionId])

  // xterm loads with the first terminal there is to attach to, and not before.
  const live = enabled ? tabIds : []
  const liveKey = live.join(' ')
  useEffect(() => {
    if (liveKey === '' && !runtimeLoaded) return
    runtimeLoaded = true
    void import('./runtime').then((m) => m.syncRuntimes(liveKey ? liveKey.split(' ') : [], { cursor, blink }))
    // The look is applied by each view; here it only seeds a new runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey])

  useCommand(
    'terminal.toggle',
    () => {
      if (sessionId) toggleTerminalFromKey(sessionId)
    },
    enabled && sessionId !== null,
  )

  useEffect(() => {
    if (listeningForChords) return
    listeningForChords = onTerminalKey((value) => {
      const chord = parseTerminalChord(value)
      if (chord && terminalEnabled(useOrbital.getState().settings)) runTerminalChord(chord)
    })
  }, [])

  const foldSidebar = opts.mainWindow && sideOnScreen
  useEffect(() => {
    if (!foldSidebar) return
    const wasCollapsed = useOrbital.getState().ui.sidebarCollapsed
    if (wasCollapsed) return
    // Not `setSidebarCollapsed`: the fold is the panel's, not a preference to save.
    useOrbital.setState((s) => ({ ui: { ...s.ui, sidebarCollapsed: true } }))
    return () => {
      if (useOrbital.getState().ui.sidebarCollapsed) {
        useOrbital.setState((s) => ({ ui: { ...s.ui, sidebarCollapsed: false } }))
      }
    }
  }, [foldSidebar])
}

/**
 * How wide the side slot's occupant asks to be in this window, or 0 with the
 * slot empty: the agent's panels at their width, else the terminal's side
 * panel (48b). Every layout that makes room for the slot reads it here.
 */
export function useSideSlotWidth(): number {
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const agentOpen = useOrbital(agentSlotOpen)
  const { sideOnScreen } = useTerminalPlacement(selectedId)
  return sideSlotWidth(agentOpen, sideOnScreen)
}
