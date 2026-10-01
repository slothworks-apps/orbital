import { useEffect, useMemo, useRef, useState } from 'react'
import { MAP_LEAVE_GRACE_MS, useOrbital } from '../store/store'
import { buildSceneModel, reuseContextFills, type SceneModel } from './sceneModel'

/**
 * `<SpaceMap>`'s scene-model subscription. Deliberately NOT
 * `useOrbital(buildSceneModel)`: `buildSceneModel` allocates a brand new
 * `{ planets, moons, labels, counts }` object every call, and zustand 5's
 * default equality is `Object.is` — so a selector that always returns a
 * new reference never "settles": new result -> store believes state
 * changed -> component re-renders -> selector runs again -> new result ->
 * ... (`Maximum update depth exceeded`, reproduced by mounting `SpaceMap`
 * pre-fix).
 *
 * Instead, this hook subscribes to only the primitive/reference slices
 * `buildSceneModel` actually reads (`sessions` — which now carries each
 * session's running subagents — `order`, `tags`,
 * and the four `ui` filter/selection fields it consults via
 * `visibleSessions`/`statusCounts`), each through its own selector — so a
 * re-render only happens when one of THOSE references/values actually
 * changes — and then recomputes the derived model itself in `useMemo`,
 * keyed on those same slices. `useMemo` returns the previous result
 * whenever its inputs are unchanged, giving `buildSceneModel`'s output a
 * stable reference across unrelated store updates (e.g. a WS status
 * change, or another session's transcript growing).
 *
 * Camera/pan/zoom state intentionally lives in `SpaceMap`'s own local
 * `useState`, not here — panning/zooming never touches the store, so it
 * can never trigger a scene-model recompute.
 */
export function useSceneModel(): SceneModel {
  const sessions = useOrbital((s) => s.sessions)
  const order = useOrbital((s) => s.order)
  const tags = useOrbital((s) => s.tags)
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const filterTagId = useOrbital((s) => s.ui.filterTagId)
  const search = useOrbital((s) => s.ui.search)
  const sourceFilter = useOrbital((s) => s.ui.sourceFilter)
  const settings = useOrbital((s) => s.settings)
  const models = useOrbital((s) => s.models)
  const contextWindows = useOrbital((s) => s.contextWindows)
  const sessionsTotal = useOrbital((s) => s.sessionsTotal)
  const leavingSince = useOrbital((s) => s.leavingSince)

  // The one impure input, kept in one place. Seeded on mount and re-read
  // once a leaving body's grace has run out, so its fade ends with it off the
  // map without the model itself reading a clock. Rescheduled on every new
  // stamp: the newest grace outlasts every earlier one, so one timer drops
  // them all.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (Object.keys(leavingSince).length === 0) return
    const timer = setTimeout(() => setNowMs(Date.now()), MAP_LEAVE_GRACE_MS)
    return () => clearTimeout(timer)
  }, [leavingSince])

  // The model this hook returned last, so an unchanged planet keeps its
  // prop identities across a rebuild (`reuseContextFills`) and its memoised
  // `Planet` skips the render.
  const previous = useRef<SceneModel | null>(null)

  const model = useMemo(
    () =>
      // `buildSceneModel` takes a full `OrbitalState` (so it can reuse
      // `mapSessions`/`statusCounts` unmodified), but only ever reads the
      // fields selected above. The rest are inert filler to satisfy the
      // type — if `buildSceneModel` (or the store selectors it calls)
      // starts reading one of them, it must be added to both this object
      // and the `useMemo` dependency array above.
      reuseContextFills(buildSceneModel(
        {
          sessions,
          order,
          tags,
          rules: [],
          models,
          contextWindows,
          settings,
          transcripts: {},
          historyLoaded: {},
          transcriptErrors: {},
          lastTurnResultAt: {},
          statsRevision: {},
          errors: [],
          errorsUnseen: 0,
          remote: null,
          pendingDecisions: {},
          decisionAnswers: {},
          decisionVerdicts: {},
          ideDismissed: {},
          composerDrafts: {},
          rewindSending: {},
          detachedIds: [],
          sessionsTotal,
          leavingSince,
          toast: null,
          subagentPanel: null,
          taskOutput: null,
          stoppingTasks: {},
          harnesses: {},
          harnessEvents: {},
          harnessPanel: null,
          ui: {
            selectedId,
            filterTagId,
            search,
            sourceFilter,
            wsStatus: '',
            dialog: null,
            sidebarCollapsed: false,
            fileViewer: null,
          },
        },
        nowMs
      ), previous.current),
    [
      sessions,
      order,
      tags,
      settings,
      models,
      contextWindows,
      sessionsTotal,
      leavingSince,
      selectedId,
      filterTagId,
      search,
      sourceFilter,
      nowMs,
    ]
  )
  useEffect(() => {
    previous.current = model
  }, [model])
  return model
}
