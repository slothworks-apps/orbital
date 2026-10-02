import { useOrbital } from '../store/store'
import { CACHE_WRITE_DEBOUNCE_MS, TRANSCRIPT_PAGE_SIZE } from './constants'
import { writeSessionsCache, writeTranscriptCache } from './platform/cache'
import { useMobile } from './state'

let timer: ReturnType<typeof setTimeout> | null = null

/** Writes what is live to the cache, so the next offline launch has something honest to show. */
export function wireCache(): () => void {
  return useOrbital.subscribe((state, prev) => {
    if (!useMobile.getState().ready) return
    const id = state.ui.selectedId
    const changed =
      state.sessions !== prev.sessions ||
      state.tags !== prev.tags ||
      (id !== null && state.transcripts[id] !== prev.transcripts[id])
    if (!changed) return
    cancelCacheWrite()
    timer = setTimeout(() => {
      timer = null
      void persist()
    }, CACHE_WRITE_DEBOUNCE_MS)
  })
}

/** Drops a write still waiting out its debounce: after a forget it would put the old Mac's data back (spec § 4). */
export function cancelCacheWrite(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

/**
 * Writes the store out, unless the pair is gone or the tunnel is not live:
 * state checked when the write runs, not when it was scheduled.
 */
export async function persist(): Promise<void> {
  const { pairing, ready } = useMobile.getState()
  if (!pairing || !ready) return
  const { sessions, tags, ui, transcripts } = useOrbital.getState()
  const now = Date.now()
  try {
    await writeSessionsCache({ sessions: Object.values(sessions), tags }, now)
    const id = ui.selectedId
    const messages = id ? transcripts[id] : undefined
    if (id && messages) await writeTranscriptCache(id, messages.slice(-TRANSCRIPT_PAGE_SIZE), now)
  } catch (err) {
    console.warn('orbital: could not write the offline cache', err)
  }
}
