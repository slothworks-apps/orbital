import { isTypingTarget } from '../lib/keymap'
import { terminalPlacement, type TerminalPlacement } from '../lib/experimental'
import { parseSessionWindowRoute } from '../lib/sessionWindowRoute'
import { useOrbital } from '../store/store'
import { chordTabIndex, type TerminalChord } from './keys'
import { useTerminals } from './store'

/**
 * Where this window puts the terminal. A detached session window has no side
 * slot to share — its agent panel resizes the window — so there the terminal
 * is always the dock under the composer (48a's note).
 */
const inSessionWindow =
  typeof window !== 'undefined' && parseSessionWindowRoute(window.location.pathname) !== null

export function placementIn(settings: Record<string, string>): TerminalPlacement {
  return inSessionWindow ? 'dock' : terminalPlacement(settings)
}

/** A subagent, ▣ output or harness holds the side slot. */
export function agentSlotOpen(state: ReturnType<typeof useOrbital.getState>): boolean {
  return state.subagentPanel !== null || state.taskOutput !== null || state.harnessPanel !== null
}

/**
 * Gives the terminal its slot back from whatever took it (48b: an agent's
 * panel replaces the side panel until it is closed). Only in the side
 * placement; the dock never shares a slot.
 */
function reclaimSideSlot(): void {
  const orbital = useOrbital.getState()
  if (placementIn(orbital.settings) !== 'side' || !agentSlotOpen(orbital)) return
  orbital.closeSubagent()
  orbital.closeTaskOutput()
  orbital.closeHarness()
}

/** Whether the session's terminal is on screen, not merely shown and waiting behind an agent's panel. */
function terminalOnScreen(sessionId: string): boolean {
  const orbital = useOrbital.getState()
  if (!useTerminals.getState().shown[sessionId]) return false
  return placementIn(orbital.settings) !== 'side' || !agentSlotOpen(orbital)
}

/** Where focus was before ⌃` took it into the terminal, so the next ⌃` can give it back. */
let returnFocus: HTMLElement | null = null

/**
 * The chip, the strip's `›_` and the hide control: show or hide, never stop
 * anything (48e). With no tab yet, the first press starts a shell.
 */
export function toggleTerminalShown(sessionId: string): void {
  const terminals = useTerminals.getState()
  if ((terminals.tabs[sessionId] ?? []).length === 0) {
    void terminals.open(sessionId)
    return
  }
  if (terminalOnScreen(sessionId)) {
    terminals.setShown(sessionId, false)
    return
  }
  reclaimSideSlot()
  terminals.setShown(sessionId, true)
}

/**
 * ⌃` (spec § Keys): the first press in a session with no terminal starts a
 * shell; later presses show and hide it and never stop anything. From the
 * composer — any field — it moves focus into the terminal; pressed in the
 * terminal it hides it and gives focus back to where it came from.
 */
export function toggleTerminalFromKey(sessionId: string): void {
  const terminals = useTerminals.getState()
  const tabs = terminals.tabs[sessionId] ?? []
  const onScreen = terminalOnScreen(sessionId)

  if (onScreen && terminals.focused) {
    terminals.setShown(sessionId, false)
    const back = returnFocus
    returnFocus = null
    if (back?.isConnected) back.focus()
    return
  }

  const from = document.activeElement
  if (onScreen && !isTypingTarget(from)) {
    terminals.setShown(sessionId, false)
    return
  }
  returnFocus = from instanceof HTMLElement && from !== document.body ? from : null

  if (tabs.length === 0) {
    void terminals.open(sessionId)
    return
  }
  reclaimSideSlot()
  terminals.setShown(sessionId, true)
  const active = terminals.active[sessionId]
  if (active) terminals.requestFocus(active)
}

/**
 * ⌘T, ⌘W or ⌘1–9 pressed in a focused terminal (spec § Keys), for the
 * selected session's tabs. ⌘W on a busy tab asks first, as × does.
 */
export function runTerminalChord(chord: TerminalChord): void {
  const sessionId = useOrbital.getState().ui.selectedId
  if (!sessionId) return
  const terminals = useTerminals.getState()
  const tabs = terminals.tabs[sessionId] ?? []
  if (chord === 'new-tab') {
    void terminals.open(sessionId)
    return
  }
  if (chord === 'close-tab') {
    const active = terminals.active[sessionId]
    if (active) terminals.requestClose(active)
    return
  }
  const index = chordTabIndex(chord)
  const tab = index !== null ? tabs[index - 1] : undefined
  if (!tab) return
  terminals.pick(sessionId, tab.id)
  terminals.requestFocus(tab.id)
}
