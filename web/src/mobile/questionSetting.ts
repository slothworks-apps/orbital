import { api } from '../lib/api'
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
 * an offline start changes no channel, and a read from a member too old
 * to know the key changes none either. Settings → About says the channel
 * the phone applied, not this value (`useAppliedChannel`).
 */
export function refreshQuestionSetting(): void {
  api
    .getSettings()
    .then((settings) => {
      channelSettingRead(settings)
      useOrbital.setState((state) => {
        if (state.settings[KEY] === settings[KEY]) return {}
        const next = { ...state.settings }
        if (settings[KEY] === undefined) delete next[KEY]
        else next[KEY] = settings[KEY]
        return { settings: next }
      })
    })
    .catch(() => {
      // Keep whatever was read last; absent reads as on.
    })
}
