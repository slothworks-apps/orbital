/**
 * The detail header's utility strip in its two forms (canvas `Feature -
 * Header actions` 23c, form 5 "adaptive"; adr
 * `the-header-strip-folds-on-the-path-width`):
 *
 * - `expanded` — stats · pin · clear · end ‖ detach · collapse, as 23a.
 * - `folded` — pin · end · ⋯ ‖ collapse; stats, clear and detach move into
 *   the ⋯ menu (23c form 4).
 *
 * Two forms only, never a priority list: the strip never drops one button at
 * a time. Pin and End never move.
 *
 * Everything here is arithmetic on the strip's known widths, so the decision
 * needs one measurement — the path cell as it is laid out now — rather than a
 * second layout of the other form.
 */

export type StripForm = 'expanded' | 'folded'

/** The strip's buttons in their on-screen order. `more` is the ⋯. */
export type StripButton = 'stats' | 'pin' | 'clear' | 'end' | 'more' | 'detach' | 'collapse'

/** Which of the strip's own buttons this session and this build offer. The ⋯ is derived. */
export type StripPresence = Record<Exclude<StripButton, 'more'>, boolean>

/** What the ⋯ menu lists, in order (23c form 4). */
export type StripMenuEntry = 'stats' | 'clear' | 'separator' | 'detach'

/** Every button in the strip is this square (canvas 9d). */
export const STRIP_BUTTON_PX = 24
/** The session actions' spacing (23a: gap 10). */
export const SESSION_GAP_PX = 10
/** The panel pair's tighter spacing (22a: detach · collapse, gap 6). */
export const PANEL_PAIR_GAP_PX = 6

/** 23d, TRIGGER: fold when the path cell would get narrower than this in the expanded form. */
export const FOLD_MIN_PATH_PX = 120
/** 23d, TRIGGER: expand only once the path would clear the fold line by this much. */
export const FOLD_HYSTERESIS_PX = 16

/** The buttons that leave the strip when it folds. */
const FOLDING_BUTTONS = ['stats', 'clear', 'detach'] as const
const FOLDING: ReadonlySet<StripButton> = new Set<StripButton>(FOLDING_BUTTONS)

const ORDER: readonly StripButton[] = ['stats', 'pin', 'clear', 'end', 'more', 'detach', 'collapse']

export interface StripSlot {
  button: StripButton
  /** Space to the left of the button — to whatever precedes it in the row. */
  marginPx: number
}

/** Either form's layout, whether or not folding would be worth it. */
function layout(folded: boolean, present: StripPresence): StripSlot[] {
  const visible = ORDER.filter((button) =>
    button === 'more' ? folded : present[button] && !(folded && FOLDING.has(button))
  )
  return visible.map((button, i) => {
    const previous = visible[i - 1]
    const pair = button === 'collapse' && (previous === 'detach' || previous === 'more')
    return { button, marginPx: pair ? PANEL_PAIR_GAP_PX : SESSION_GAP_PX }
  })
}

const widthOf = (slots: StripSlot[]) =>
  slots.reduce((sum, slot) => sum + STRIP_BUTTON_PX + slot.marginPx, 0)

/** What folding hands back to the path — the expanded strip's width less the folded one's. */
function savingPx(present: StripPresence): number {
  return widthOf(layout(false, present)) - widthOf(layout(true, present))
}

/**
 * Whether the strip has a folded form at all. The ⋯ has to stand in for more
 * than one button: a lone folding button would be traded for a ⋯ of the same
 * size, and the action would cost a second click for a few pixels of gap.
 */
export function isFoldable(present: StripPresence): boolean {
  return FOLDING_BUTTONS.filter((button) => present[button]).length > 1
}

/** How much wider the path cell is in the folded form than in the expanded one. */
export function foldSavingPx(present: StripPresence): number {
  return isFoldable(present) ? savingPx(present) : 0
}

/**
 * The visible buttons of one form, each with the margin it sits at.
 *
 * Collapse sits at the pair's gap after detach or the ⋯, and at the session
 * gap straight after End — the browser build's expanded strip, which has no
 * detach (22a). A strip not worth folding is the expanded one in both forms.
 */
export function stripLayout(form: StripForm, present: StripPresence): StripSlot[] {
  return layout(form === 'folded' && isFoldable(present), present)
}

/** The strip's width in one form: buttons plus the margins in front of them. */
export function stripWidthPx(form: StripForm, present: StripPresence): number {
  return widthOf(stripLayout(form, present))
}

/**
 * Which form the strip should be in, given the path cell's width as it is
 * laid out now, in `current`.
 *
 * Both edges are judged on the width the path WOULD have in the expanded
 * form, so the answer does not depend on which form happened to be measured.
 * Between the two edges the strip stays as it is — that band is what stops it
 * flickering while a panel is dragged across the line.
 *
 * A width of zero is a cell that has not been laid out (a hidden panel, a
 * test environment); it says nothing, so nothing changes.
 */
export function stripForm(pathWidthPx: number, current: StripForm, present: StripPresence): StripForm {
  if (!isFoldable(present)) return 'expanded'
  if (!(pathWidthPx > 0)) return current
  const expandedPathPx = current === 'expanded' ? pathWidthPx : pathWidthPx - savingPx(present)
  if (expandedPathPx < FOLD_MIN_PATH_PX) return 'folded'
  if (expandedPathPx >= FOLD_MIN_PATH_PX + FOLD_HYSTERESIS_PX) return 'expanded'
  return current
}

/**
 * The ⋯ menu's rows (23c form 4): stats, clear, a hairline, detach. The
 * hairline keeps 22a's session / panel split, so it goes wherever detach goes
 * — the browser build, which has no detach, ends before it.
 */
export function stripMenu(present: StripPresence): StripMenuEntry[] {
  const entries: StripMenuEntry[] = []
  if (present.stats) entries.push('stats')
  if (present.clear) entries.push('clear')
  if (present.detach) {
    if (entries.length > 0) entries.push('separator')
    entries.push('detach')
  }
  return entries
}
