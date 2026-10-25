import { api } from '../lib/api'
import { useOrbital } from '../store/store'

/** The one Mac setting the phone obeys (spec 2026-10-21-question-card-go-back-design § Setting). */
const KEY = 'questions_review_before_send'

/**
 * Reads the Mac's `questions_review_before_send` into the phone's settings.
 * The phone holds no settings of its own otherwise, so only this key is
 * taken. Best-effort: a Mac too old to have the key, or a pairing without
 * the settings grant, leaves it absent, and absent reads as on — the review
 * needs nothing from the Mac (the answer POST is unchanged). In a group the
 * read goes to a Mac that shares the group's settings, so every Mac's
 * question cards follow one value (`GroupFederation.settingsSource`).
 */
export function refreshQuestionSetting(): void {
  api
    .getSettings()
    .then((settings) => {
      const value = settings[KEY]
      useOrbital.setState((state) => {
        if (state.settings[KEY] === value) return {}
        const next = { ...state.settings }
        if (value === undefined) delete next[KEY]
        else next[KEY] = value
        return { settings: next }
      })
    })
    .catch(() => {
      // Keep whatever was read last; absent reads as on.
    })
}
