import { api } from '../lib/api'
import { UPDATE_CHANNEL_KEY } from '../lib/updateChannel'
import { useOrbital } from '../store/store'
import { channelSettingRead } from './update/channel'

/** The Mac setting the question cards obey (spec 2026-10-21-question-card-go-back-design § Setting). */
const KEY = 'questions_review_before_send'

/**
 * Reads the Mac's `questions_review_before_send` into the phone's settings.
 * The phone holds no settings of its own otherwise, so only this key is
 * taken. Best-effort: a Mac too old to have the key, or a pairing without
 * the settings grant, leaves it absent, and absent reads as on — the review
 * needs nothing from the Mac (the answer POST is unchanged). In a group the
 * read goes to a Mac that shares the group's settings, so every Mac's
 * question cards follow one value (`GroupFederation.settingsSource`).
 *
 * The same read carries the group's `update_channel`, which the phone's
 * updater follows (`update/channel.ts`); only an answered read counts, so
 * an offline start changes no channel. It is kept in the phone's settings
 * too, for Settings → About to say experimental (canvas `Feature -
 * Experimental updates` 1g).
 */
export function refreshQuestionSetting(): void {
  api
    .getSettings()
    .then((settings) => {
      channelSettingRead(settings)
      useOrbital.setState((state) => {
        const changed = [KEY, UPDATE_CHANNEL_KEY].filter((k) => state.settings[k] !== settings[k])
        if (changed.length === 0) return {}
        const next = { ...state.settings }
        for (const k of changed) {
          if (settings[k] === undefined) delete next[k]
          else next[k] = settings[k]
        }
        return { settings: next }
      })
    })
    .catch(() => {
      // Keep whatever was read last; absent reads as on.
    })
}
