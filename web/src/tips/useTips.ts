import { useMemo } from 'react'
import { api } from '../lib/api'
import { recordError } from '../lib/errors'
import { STATS_PATH } from '../stats/route'
import { openSettingsSection, useOrbital } from '../store/store'
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

/**
 * Remembers `ids` as shown on this Mac. Not before the settings are in: the
 * mark would replace the stored list with only what was shown since launch.
 */
export function markTipsSeen(ids: Iterable<string>): void {
  const state = useOrbital.getState()
  if (state.settingsLoaded !== true) return
  const value = markedSeen(state.settings[TIPS_SEEN_KEY], ids)
  if (value === null) return
  useOrbital.setState((s) => ({ settings: { ...s.settings, [TIPS_SEEN_KEY]: value } }))
  writeSeen(value)
}

// One write at a time, so two quick marks cannot land out of order: a mark
// made while one is in flight waits, and only the latest is sent after it.
let writing = false
let waiting: string | null = null

function writeSeen(value: string): void {
  waiting = value
  if (writing) return
  writing = true
  waiting = null
  // A failed write costs the dot once more; it is recorded, not announced.
  api
    .patchSettings({ [TIPS_SEEN_KEY]: value })
    .catch((err) => recordError(err, 'Could not remember which tips were shown'))
    .finally(() => {
      writing = false
      if (waiting !== null) writeSeen(waiting)
    })
}

/**
 * Does a tip's one thing. It only opens: a Settings section, New session,
 * New session with the prompt written in, or Stats; it never starts a session
 * or sends a message.
 */
export function runTipAction(action: TipAction): void {
  switch (action.kind) {
    case 'settings':
      // This visit opens on the tip's section; the stored one stays the user's own pick.
      openSettingsSection(action.section, { persist: false })
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
