import { useMemo } from 'react'
import { api } from '../lib/api'
import { STATS_PATH } from '../stats/route'
import { useOrbital } from '../store/store'
import { openNewSessionWithPrompt } from '../store/setupActions'
import { TIPS_SEEN_KEY, hasUnseenTips, markedSeen, parseSeenTips, type TipAction } from '../lib/tips'
import { TIPS } from './tipList'

/**
 * The tips this Mac has shown, read from its server setting. Empty until the
 * settings are in, but `dot` stays off until then, so a launch does not flash it.
 */
export function useSeenTips(): { seen: Set<string>; dot: boolean } {
  const raw = useOrbital((s) => s.settings[TIPS_SEEN_KEY])
  const loaded = useOrbital((s) => s.settingsLoaded === true)
  return useMemo(() => {
    const seen = parseSeenTips(raw)
    return { seen, dot: loaded && hasUnseenTips(TIPS, seen) }
  }, [raw, loaded])
}

/** Remembers `ids` as shown on this Mac. A failed write costs the dot once more, not an error. */
export function markTipsSeen(ids: Iterable<string>): void {
  const value = markedSeen(useOrbital.getState().settings[TIPS_SEEN_KEY], ids)
  if (value === null) return
  useOrbital.setState((state) => ({ settings: { ...state.settings, [TIPS_SEEN_KEY]: value } }))
  api.patchSettings({ [TIPS_SEEN_KEY]: value }).catch(() => {})
}

/**
 * Does a tip's one thing. It only opens: a Settings section, New session,
 * New session with the prompt written in, or Stats; it never starts a session
 * or sends a message.
 */
export function runTipAction(action: TipAction): void {
  switch (action.kind) {
    case 'settings':
      // In memory only, like the harness templates' way in: this visit opens
      // on the tip's section, and the stored one stays the user's own pick.
      useOrbital.setState((state) => ({
        settings: { ...state.settings, settings_last_section: action.section },
        ui: { ...state.ui, dialog: 'settings' },
      }))
      return
    case 'new-session':
      useOrbital.getState().setDialog('new')
      return
    case 'new-session-prompt':
      openNewSessionWithPrompt(action.prompt)
      return
    case 'stats':
      window.location.assign(STATS_PATH)
      return
  }
}
