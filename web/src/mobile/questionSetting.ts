import { create } from 'zustand'
import { api } from '../lib/api'
import { VIEWS_ENABLED_KEY, harnessEnabled, viewsEnabled } from '../lib/experimental'
import { useOrbital } from '../store/store'
import { channelSettingRead } from './update/channel'
import { defaultSupports } from './version'

/** The Mac setting the question cards obey (spec 2026-10-21-question-card-go-back-design § Setting). */
const KEY = 'questions_review_before_send'

/**
 * The Harness switch as the last answered settings read had it, kept apart
 * from the phone's settings because absent there means off: here null means
 * not known — never read, or refused (a pairing without the settings grant).
 * New session hides *With harness…* only on a known off (`offersHarness`);
 * otherwise the template route says so itself (spec
 * 2026-11-09-harness-from-new-session-design § Phone).
 */
export const useMacHarnessSetting = create<{ on: boolean | null }>(() => ({ on: null }))

/**
 * Labs → Views into the phone's settings (spec
 * 2026-11-18-generated-views-design § Phone), as the Mac holds it, and only
 * when the Mac serves views (`MAC_FEATURES.views`): the session's media asks
 * for view items (`?views=1`) by `viewsEnabled` of these settings, as on the
 * Mac. Absent reads as off.
 */
export function takeMacViewsSetting(on: boolean): void {
  const value = on && defaultSupports('views') ? 'true' : undefined
  useOrbital.setState((state) => {
    if (state.settings[VIEWS_ENABLED_KEY] === value) return {}
    const next = { ...state.settings }
    if (value === undefined) delete next[VIEWS_ENABLED_KEY]
    else next[VIEWS_ENABLED_KEY] = value
    return { settings: next }
  })
}

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
 * the phone applied, not this value (`useAppliedChannel`). It carries the
 * Harness switch too (`useMacHarnessSetting`), and Labs → Views
 * (`takeMacViewsSetting`).
 */
export function refreshQuestionSetting(): void {
  api
    .getSettings()
    .then((settings) => {
      channelSettingRead(settings)
      const on = harnessEnabled(settings)
      if (useMacHarnessSetting.getState().on !== on) useMacHarnessSetting.setState({ on })
      takeMacViewsSetting(viewsEnabled(settings))
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
