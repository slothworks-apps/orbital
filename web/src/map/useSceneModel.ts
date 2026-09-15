import { useMemo } from 'react'
import { useOrbital } from '../store/store'
import { buildSceneModel, type SceneModel } from './sceneModel'

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
 * `buildSceneModel` actually reads (`sessions`, `order`, `tags`,
 * `subagents`, and the four `ui` filter/selection fields it consults via
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
  const subagents = useOrbital((s) => s.subagents)
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const filterTagId = useOrbital((s) => s.ui.filterTagId)
  const search = useOrbital((s) => s.ui.search)
  const sourceFilter = useOrbital((s) => s.ui.sourceFilter)

  return useMemo(
    () =>
      // `buildSceneModel` takes a full `OrbitalState` (so it can reuse
      // `visibleSessions`/`statusCounts` unmodified), but only ever reads
      // the 8 fields selected above. The rest are inert filler to satisfy
      // the type — if `buildSceneModel` (or the store selectors it calls)
      // starts reading one of them, it must be added to both this object
      // and the `useMemo` dependency array above.
      buildSceneModel({
        sessions,
        order,
        tags,
        rules: [],
        settings: {},
        transcripts: {},
        subagents,
        usage: {},
        historyLoaded: {},
        toast: null,
        ui: {
          selectedId,
          filterTagId,
          search,
          sourceFilter,
          wsStatus: '',
          dialog: null,
        },
      }),
    [sessions, order, tags, subagents, selectedId, filterTagId, search, sourceFilter]
  )
}
