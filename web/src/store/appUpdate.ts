import { create } from 'zustand'
import type { UpdateBridge, UpdateState } from '../lib/desktop'

/**
 * The desktop app's update as this window knows it (canvas `Feature - App
 * update`): the bridge it came through, and the last state main pushed.
 * Both stay null in a browser and on the phone, which is what keeps the
 * UPDATE notice and Settings › Updates out of them.
 */
interface AppUpdateState {
  source: UpdateBridge | null
  state: UpdateState | null
  /**
   * What the prompt draws: `state`, except that `restarting` keeps the
   * state before it — nothing new is said while the app quits into the update.
   */
  shown: UpdateState | null
  connect(source: UpdateBridge): void
}

export const useAppUpdate = create<AppUpdateState>()((set, get) => {
  const take = (state: UpdateState) =>
    set((s) => ({ state, shown: state.phase === 'restarting' ? s.shown : state }))
  return {
    source: null,
    state: null,
    shown: null,
    connect(source) {
      if (get().source) return
      set({ source })
      source.onUpdateState(take)
      // Asked once on load, so a reload keeps the prompt; a push that landed
      // first is newer and wins.
      void source.getUpdateState().then((state) => {
        if (get().state === null) take(state)
      })
    },
  }
})
