import { endClosesPanel, useOrbital } from '../store/store'
import { ClearDialog } from './ClearDialog'
import { EndDialog } from './EndDialog'
import { TakeOverDialog } from './TakeOverDialog'

/**
 * Take over, Clear and End, for whichever session asked: the detail header
 * asks for the selected one, the context menu for any session on the map or
 * in the sidebar without selecting it (spec
 * 2026-10-24-session-context-menu-design) — `dialogSessionId`. One mount
 * serves both, so it lives with the window rather than inside the panel,
 * which draws nothing while no session is open.
 *
 * `standalone`: a detached session window, which is the panel itself, so an
 * End never closes it.
 */
export function SessionDialogs({ standalone = false }: { standalone?: boolean }) {
  const dialog = useOrbital((s) => s.ui.dialog)
  const sessionId = useOrbital((s) => s.ui.dialogSessionId ?? s.ui.selectedId)
  const close = () => useOrbital.getState().setDialog(null)
  return (
    <>
      <TakeOverDialog open={dialog === 'take-over'} sessionId={sessionId} onClose={close} />
      <ClearDialog open={dialog === 'clear'} sessionId={sessionId} onClose={close} />
      <EndDialog
        open={dialog === 'end'}
        sessionId={sessionId}
        onClose={close}
        onEnd={async (endedId) => {
          await useOrbital.getState().endSession(endedId)
          // `end_closes_panel`: an ended session has nothing left to do here,
          // so the panel goes the way collapse sends it. Not in a detached
          // window, which is the panel itself, and not when the selection
          // has already moved on while the end was in flight — or was never
          // on it, for an End from the context menu.
          if (standalone || !endClosesPanel(useOrbital.getState().settings)) return
          useOrbital.setState((s) =>
            s.ui.selectedId === endedId ? { ui: { ...s.ui, selectedId: null } } : s,
          )
        }}
      />
    </>
  )
}
