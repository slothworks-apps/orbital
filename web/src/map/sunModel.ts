import type { LimitsAccountGroup } from '@orbital/shared/limits'
import { accountViews, sunAccountKeys } from '../limits/accounts'
import { formatResetShort } from '../lib/limits'
import {
  sunColors,
  sunPositions,
  sunReading,
  sunTiles,
  type SunColor,
  type SunPosition,
  type SunReading,
} from '../lib/limitSuns'
import type { ClaudeDirLimits, LimitsSnapshot } from '../lib/types'
import { REFERENCE_ZOOM } from './camera'
import { HOLE_CLEARANCE } from './layout'

/**
 * The limit suns on the map (spec 2026-10-20-limit-suns-design § 4; canvas
 * `Feature - Limit sun` 60b, 60f): which suns there are, what each wears, and
 * where each sits. Pure — no three.js, no React — so the placement and the
 * press-or-drag rule are tested; `LimitSun.tsx` draws the answers.
 */

type Settings = Record<string, string | undefined>

/**
 * Canvas px → world units. 60f quotes the sun "at 100 % zoom", and the map's
 * zoom readout is the camera's zoom, so one canvas px is a hundredth of a
 * world unit — `bodyDesignPxToScreenPx`'s conversion.
 */
export const SUN_PX = 0.01

/**
 * 60f IN SPACE: suns shown for the first time sit side by side, 220 px
 * apart — on screen at the map's default zoom, where they are first seen.
 * At 100 % the labels, which keep their size, would overlap there.
 */
export const SUN_SPACING = 220 / REFERENCE_ZOOM

/**
 * How far above the planets' field the default row sits, in world units:
 * past a cluster label over the topmost planet, so a sun nobody has placed
 * never lands on the field (spec § 4, Default position).
 */
export const SUN_FIELD_CLEARANCE = 2

/**
 * Below this many screen px of movement, a pointer down+up is a click, not a
 * drag: a pan of the map, a planet's drag and a sun's (60f CLICK / DRAG) alike.
 */
export const DRAG_THRESHOLD_PX = 3

/** Whether a press on a sun has become a drag (60b's `Math.hypot(dx, dy) > 3`). */
export function sunPressMoved(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX
}

/**
 * The radius of the circle that bounds the planets' field, read back off the
 * trash, which `holePosition` puts `HOLE_CLEARANCE` beyond it.
 */
export function fieldRadiusFromHole(hole: SunPosition): number {
  return Math.max(0, Math.hypot(hole.x, hole.y) - HOLE_CLEARANCE)
}

/**
 * Where the `index`th sun sits until it is dragged (60f IN SPACE: top left):
 * a row above the field's bounding circle, starting over its left edge and
 * running right. The trash is on the opposite, bottom-right diagonal.
 */
export function defaultSunPosition(index: number, fieldRadius: number): SunPosition {
  return { x: -fieldRadius + index * SUN_SPACING, y: fieldRadius + SUN_FIELD_CLEARANCE }
}

/** One sun as the map draws it. */
export interface MapSun {
  /** The account key (`limitsAccountKey`): what its position and colour are stored under. */
  key: string
  group: LimitsAccountGroup<ClaudeDirLimits>
  /** The card's heading: the e-mail, else the directory's name. */
  title: string
  color: SunColor
  reading: SunReading
  stale: boolean
  /** `13:42` (`Wed 13:42` on another day): when the shown reading was taken. */
  readClock: string
  /** The directory tiles, only with two accounts or more (60f LABEL). */
  tiles: string[]
  /** Where it sits now: the stored position, else its default. */
  position: SunPosition
  /** Whether `position` is the stored one. */
  placed: boolean
}

/**
 * The suns for a snapshot: one per account with plan limits that has been
 * read at least once (spec § 4: no sun until the first reading, none for an
 * API key or an account billed by usage). `hole` is the trash's position,
 * which the default row is placed against.
 */
export function mapSuns(
  snapshot: LimitsSnapshot | null,
  settings: Settings,
  hole: SunPosition,
  now: number,
): MapSun[] {
  if (!snapshot) return []
  // The page's own account views, so a sun wears the tiles its account head
  // wears on /limits, and its colour is taken in the same order there and in
  // Settings → Appearance.
  const views = accountViews(snapshot.dirs, { dirInfo: null, self: null, now })
  const keys = sunAccountKeys(views)
  const colors = sunColors(keys, settings)
  // 60f LABEL: with one account, no tiles, and yellow whatever was stored.
  const one = keys.length === 1
  const shown = views.filter((v) => v.group.reading.tracked && v.group.reading.readAt !== null)
  const stored = sunPositions(settings)
  const radius = fieldRadiusFromHole(hole)
  return shown.map((view, index) => {
    const { group } = view
    const at = stored.get(group.key)
    const tiles = sunTiles(view.dirs.map((d) => d.mono))
    return {
      key: group.key,
      group,
      title: view.title,
      color: one ? 'yellow' : (colors.get(group.key) ?? 'yellow'),
      reading: sunReading(group.reading.windows, now, group.reading.extraUsage),
      stale: view.stale,
      readClock: formatResetShort(group.reading.readAt, now),
      tiles: one ? [] : [...tiles.tiles, ...(tiles.more > 0 ? [`+${tiles.more}`] : [])],
      position: at ?? defaultSunPosition(index, radius),
      placed: at !== undefined,
    }
  })
}

/**
 * The hover card's width, and the room it keeps above the map's bottom. 60b
 * draws it 300 px wide, where a reset beside the longest estimate ("resets
 * Fri 07:00 · no estimate · reading is out of date") wraps; widened so every
 * row's foot stays on one line.
 */
export const SUN_CARD_WIDTH_PX = 360
const SUN_CARD_ROOM_PX = 330
/** 60b: the card's top sits this far above the sun's centre… */
const SUN_CARD_RAISE_PX = 40
/** …and never closer than this to the map's top. */
const SUN_CARD_EDGE_PX = 16
/**
 * 60b's offsets from the sun's centre at 100 % zoom (`sx + 44` to the right,
 * `sx - 40 - 300` to the left), kept as gaps beyond the hover ring so they
 * follow the sun's drawn size.
 */
const SUN_CARD_GAP_RIGHT_PX = 44 - 33
const SUN_CARD_GAP_LEFT_PX = 40 - 33
/**
 * 60b turns its 300 px card to the left past `sx > 1060` on its 1440 px board;
 * the room on the right that takes grows with the card's width.
 */
const SUN_CARD_FLIP_ROOM_PX = 1440 - 1060 + (SUN_CARD_WIDTH_PX - 300)

/**
 * Where the hover card goes, in px within the map: right of the sun, or left
 * of it when the right has no room; `ringPx` is the hover ring's drawn radius.
 */
export function sunCardPlacement(
  sun: { x: number; y: number },
  ringPx: number,
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left =
    sun.x > viewport.width - SUN_CARD_FLIP_ROOM_PX
      ? sun.x - ringPx - SUN_CARD_GAP_LEFT_PX - SUN_CARD_WIDTH_PX
      : sun.x + ringPx + SUN_CARD_GAP_RIGHT_PX
  const top = Math.max(SUN_CARD_EDGE_PX, Math.min(sun.y - SUN_CARD_RAISE_PX, viewport.height - SUN_CARD_ROOM_PX))
  return { left: Math.round(left), top: Math.round(top) }
}
