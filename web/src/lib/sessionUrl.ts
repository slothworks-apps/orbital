import { useEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from './api'

/**
 * The selected session, mirrored into the address bar.
 *
 * A query parameter rather than a path segment: the app is served as a single
 * static page, so `/s/<id>` would need a rewrite rule on the server (and in
 * `vite preview`, and in anything that ever hosts the built bundle) before a
 * refresh could work at all. `?session=<id>` needs nothing.
 */
export const SESSION_PARAM = 'session'

export function readSessionParam(href: string = window.location.href): string | null {
  const id = new URL(href).searchParams.get(SESSION_PARAM)
  return id && id.length > 0 ? id : null
}

/**
 * The same URL with the session parameter set to `id` (or removed for `null`),
 * as a same-document relative URL — `history.pushState` wants exactly that,
 * and it keeps every other parameter and the hash untouched.
 */
export function withSessionParam(id: string | null, href: string = window.location.href): string {
  const url = new URL(href)
  if (id) url.searchParams.set(SESSION_PARAM, id)
  else url.searchParams.delete(SESSION_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * Selects the session a restored URL names.
 *
 * `loadInitial` only fetches the first page of sessions, so a link to an older
 * one can point at a session the store has never heard of — that one is
 * fetched by id and upserted before selecting, or the parameter is dropped if
 * the server doesn't know it either. Without the fetch the app would select an
 * id it has no record of and show an empty detail panel.
 */
async function restoreSelection(id: string, select: (id: string) => Promise<void>): Promise<void> {
  if (!useOrbital.getState().sessions[id]) {
    try {
      const { session } = await api.getSession(id)
      useOrbital.getState().applySessionsEvent({ event: 'upsert', session })
    } catch {
      // A link to a session that no longer exists. Drop the parameter so a
      // second refresh doesn't try again, and leave nothing selected.
      window.history.replaceState(null, '', withSessionParam(null))
      return
    }
  }
  await select(id)
}

/**
 * Keeps `ui.selectedId` and the address bar in step, in both directions:
 * refreshing reopens the session that was selected, and Back/Forward walk the
 * selections the way they walk pages.
 *
 * `ready` must only go true once the initial load has landed. `loadInitial`
 * replaces the whole `sessions` map wholesale, so a session fetched by id
 * before then would be thrown away moments later.
 *
 * Selection changes `pushState` rather than `replaceState`: the detail panel
 * reads as a place, and Back closing it is what a browser user expects. The
 * restore itself is deliberately NOT pushed — it is the entry the user landed
 * on, not a step they took.
 */
export function useSessionUrl(ready: boolean): void {
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const select = useOrbital((s) => s.select)
  /** Guards the restore against `StrictMode`'s double-invoked effects. */
  const restoreStarted = useRef(false)
  /**
   * State, not a ref, because the mirror below must not run until the restore
   * has settled: effects run in declaration order within one commit, so a ref
   * set by the restore would let the mirror see `selectedId` still null and
   * push the id it was about to restore straight back out of the URL.
   */
  const [restored, setRestored] = useState(false)

  useEffect(() => {
    if (!ready || restoreStarted.current) return
    restoreStarted.current = true
    const id = readSessionParam()
    if (!id) {
      setRestored(true)
      return
    }
    void restoreSelection(id, select).finally(() => setRestored(true))
  }, [ready, select])

  useEffect(() => {
    if (!restored) return
    if (readSessionParam() === selectedId) return
    window.history.pushState(null, '', withSessionParam(selectedId))
  }, [restored, selectedId])

  useEffect(() => {
    const handlePopState = () => {
      const id = readSessionParam()
      if (id === useOrbital.getState().ui.selectedId) return
      if (id) {
        void select(id)
        return
      }
      useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null } }))
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [select])
}
