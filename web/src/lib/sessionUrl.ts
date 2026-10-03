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

/**
 * The file viewer, same scheme (spec: 2026-09-19-file-viewer-design):
 * `?session=<id>&file=<path>&line=42`. The two only ever appear alongside a
 * session — the viewer belongs to the selected session.
 */
export const FILE_PARAM = 'file'
export const LINE_PARAM = 'line'

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
 * `/?new=1` — "open the New Session dialog once the map is up".
 *
 * The dialog belongs to the map (`App` renders it), and `/stats` is its own
 * top-level screen with no map underneath, so the stats empty state's CTA
 * cannot simply set the store's `ui.dialog`: the navigation to `/` is a full
 * page load that throws that state away. It asks in the URL instead, and
 * `App` strips the parameter as it opens the dialog so a refresh does not
 * reopen it.
 */
export const NEW_SESSION_PARAM = 'new'

export function readNewSessionParam(href: string = window.location.href): boolean {
  return new URL(href).searchParams.has(NEW_SESSION_PARAM)
}

/** The same URL without the request — what replaces it once the dialog is open. */
export function withoutNewSessionParam(href: string = window.location.href): string {
  const url = new URL(href)
  url.searchParams.delete(NEW_SESSION_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * `/?settings=<section>` — "open Settings on this section once the map is
 * up", the same kind of request as `?new=1` and for the same reason: the
 * limits page links to Settings → Sessions, and Settings is a dialog of the
 * map (spec 2026-10-03-usage-limits-design § 2 "After a reset").
 */
export const SETTINGS_PARAM = 'settings'

export function readSettingsParam(href: string = window.location.href): string | null {
  const section = new URL(href).searchParams.get(SETTINGS_PARAM)
  return section && section.length > 0 ? section : null
}

export function withoutSettingsParam(href: string = window.location.href): string {
  const url = new URL(href)
  url.searchParams.delete(SETTINGS_PARAM)
  return `${url.pathname}${url.search}${url.hash}`
}

/** The map's URL that opens Settings on `section`. */
export const settingsHref = (section: string): string => `/?${SETTINGS_PARAM}=${encodeURIComponent(section)}`

/**
 * Opens Settings on `section`. The dialog opens on the last section the user
 * chose (`settings_last_section`), so this makes `section` that choice, here
 * and on the server, before it opens.
 */
export function openSettingsSection(section: string): void {
  useOrbital.setState((state) => ({ settings: { ...state.settings, settings_last_section: section } }))
  void api.patchSettings({ settings_last_section: section }).catch(() => {})
  useOrbital.getState().setDialog('settings')
}

/** The store's `ui.fileViewer` shape, as the URL carries it. */
export type FileViewerTarget = { path: string; line: number | null }

/** The viewer target a URL names, or null when it names none. An
 * unparseable `line` is dropped, not an error — same posture as an empty
 * session parameter. */
export function readFileParams(href: string = window.location.href): FileViewerTarget | null {
  const params = new URL(href).searchParams
  const path = params.get(FILE_PARAM)
  if (!path) return null
  const rawLine = params.get(LINE_PARAM)
  const line = rawLine !== null && /^\d+$/.test(rawLine) ? Number(rawLine) : null
  return { path, line }
}

/** The same URL with the file (and line) parameters set or removed. */
export function withFileParams(
  viewer: FileViewerTarget | null,
  href: string = window.location.href
): string {
  const url = new URL(href)
  if (viewer) {
    url.searchParams.set(FILE_PARAM, viewer.path)
    if (viewer.line !== null) url.searchParams.set(LINE_PARAM, String(viewer.line))
    else url.searchParams.delete(LINE_PARAM)
  } else {
    url.searchParams.delete(FILE_PARAM)
    url.searchParams.delete(LINE_PARAM)
  }
  return `${url.pathname}${url.search}${url.hash}`
}

function sameTarget(a: FileViewerTarget | null, b: FileViewerTarget | null): boolean {
  if (a === null || b === null) return a === b
  return a.path === b.path && a.line === b.line
}

/** One relative URL carrying both mirrored pieces of ui state. */
function mirroredUrl(selectedId: string | null, viewer: FileViewerTarget | null): string {
  const url = new URL(window.location.href)
  if (selectedId) url.searchParams.set(SESSION_PARAM, selectedId)
  else url.searchParams.delete(SESSION_PARAM)
  return withFileParams(viewer, url.href)
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
      // A link to a session that no longer exists. Drop the parameter (and
      // any file riding on it — a viewer with no session names nothing) so a
      // second refresh doesn't try again, and leave nothing selected.
      window.history.replaceState(null, '', withFileParams(null, new URL(withSessionParam(null), window.location.href).href))
      return
    }
  }
  await select(id)
}

/**
 * Keeps `ui.selectedId` + `ui.fileViewer` and the address bar in step, in
 * both directions: refreshing reopens the session (and file) that was open,
 * and Back/Forward walk the selections the way they walk pages.
 *
 * `ready` must only go true once the initial load has landed. `loadInitial`
 * replaces the whole `sessions` map wholesale, so a session fetched by id
 * before then would be thrown away moments later.
 *
 * Selection changes `pushState` rather than `replaceState`: the detail panel
 * reads as a place, and Back closing it is what a browser user expects. The
 * same goes for opening and closing the viewer. The restore itself is
 * deliberately NOT pushed — it is the entry the user landed on, not a step
 * they took.
 */
export function useSessionUrl(ready: boolean): void {
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const fileViewer = useOrbital((s) => s.ui.fileViewer)
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

  // Mirrored into the store for consumers outside this hook — the map's
  // fit-on-load waits on it so it frames the strip the restored session's
  // detail panel will actually leave (`ui.urlRestored`).
  useEffect(() => {
    if (!restored) return
    useOrbital.setState((state) => ({ ui: { ...state.ui, urlRestored: true } }))
  }, [restored])

  useEffect(() => {
    if (!ready || restoreStarted.current) return
    restoreStarted.current = true
    const id = readSessionParam()
    const file = readFileParams()
    if (!id) {
      // A file parameter with no session names nothing — drop it so the
      // mirror doesn't push a correction entry for a URL nobody made.
      if (file) window.history.replaceState(null, '', withFileParams(null))
      setRestored(true)
      return
    }
    void restoreSelection(id, select)
      .then(() => {
        // The viewer opens only once its session actually settled — a
        // dropped/unknown session id takes the file parameter down with it.
        if (file && useOrbital.getState().ui.selectedId === id) {
          useOrbital.getState().openFile(file.path, file.line)
        }
      })
      .finally(() => setRestored(true))
  }, [ready, select])

  useEffect(() => {
    if (!restored) return
    if (readSessionParam() === selectedId && sameTarget(readFileParams(), fileViewer)) return
    window.history.pushState(null, '', mirroredUrl(selectedId, fileViewer))
  }, [restored, selectedId, fileViewer])

  useEffect(() => {
    const handlePopState = () => {
      const id = readSessionParam()
      const file = readFileParams()
      const state = useOrbital.getState()
      if (id !== state.ui.selectedId) {
        if (id) {
          // Both writes are synchronous, in one task: `select` seats the
          // session (clearing any other session's viewer) and `openFile`
          // seats the file BEFORE the mirror effect runs, so the mirror
          // never sees the half-applied state and pushes a correction.
          void select(id)
          if (file) useOrbital.getState().openFile(file.path, file.line)
          return
        }
        useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null, fileViewer: null } }))
        return
      }
      // Same session — only the viewer moved.
      if (sameTarget(file, state.ui.fileViewer)) return
      if (file) state.openFile(file.path, file.line)
      else state.closeFile()
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [select])
}
