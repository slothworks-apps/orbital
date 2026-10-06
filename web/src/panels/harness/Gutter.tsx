import type { GutterRow } from '../../lib/harnessGraph'
import { Marker } from './parts'
import type { StepKind } from './model'

/** One lane's width; lane 0 sits where the single rail always sat. */
export const LANE_PX = 14
/** The marker's centre, from the row's top (it sits 5 px down, 9 px tall). */
const MARKER_Y = 9.5
/** Where a line leaves the marker downwards (30d: 7 px under it). */
const BELOW_Y = 21
const LINE = 'rgba(150,205,255,.12)'

const x = (lane: number) => lane * LANE_PX + LANE_PX / 2

function VLine({ lane, top, bottom = 0 }: { lane: number; top: number; bottom?: number }) {
  return <span aria-hidden className="absolute block w-px" style={{ left: x(lane) - 0.5, top, bottom, background: LINE }} />
}

/**
 * A step row's gutter (spec 2026-10-06-harness-graph-and-proposals-design §
 * The panel): the step's marker in its lane, the lines passing by, those
 * joining it from above and those leaving it below — `git log --graph`.
 * A plain list draws the one rail it always drew.
 */
export function GutterCell({ row, lanes, kind, gate }: { row: GutterRow; lanes: number; kind: StepKind; gate: boolean }) {
  const curves = [
    ...row.merges.map((l) => `M${x(l)} 0 C${x(l)} ${MARKER_Y} ${x(row.lane)} 0 ${x(row.lane)} ${MARKER_Y}`),
    ...row.forks.map((l) => `M${x(row.lane)} ${MARKER_Y} C${x(row.lane)} ${BELOW_Y} ${x(l)} ${MARKER_Y} ${x(l)} ${BELOW_Y}`),
  ]
  return (
    <div className="relative shrink-0 self-stretch" style={{ width: lanes * LANE_PX }}>
      {row.through.map((l) => (
        <VLine key={`t${l}`} lane={l} top={0} />
      ))}
      {row.bottom && <VLine lane={row.lane} top={BELOW_Y} />}
      {row.forks.map((l) => (
        <VLine key={`f${l}`} lane={l} top={BELOW_Y} />
      ))}
      {curves.length > 0 && (
        <svg aria-hidden className="absolute left-0 top-0" width={lanes * LANE_PX} height={BELOW_Y} fill="none" stroke={LINE}>
          {curves.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      )}
      <span className="absolute top-[5px]" style={{ left: x(row.lane) - 4.5 }}>
        <Marker kind={kind} gate={gate} />
      </span>
    </div>
  )
}

/**
 * The lines carrying on past an event's dashed row between the steps. Lane 0
 * is left out, as the single rail always left it; the row's margins (-4 px
 * above, 14 px below) are bridged.
 */
export function GutterPass({ below }: { below: number[] }) {
  return (
    <>
      {below
        .filter((l) => l > 0)
        .map((l) => (
          <VLine key={l} lane={l} top={-4} bottom={-14} />
        ))}
    </>
  )
}
