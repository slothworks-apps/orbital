/**
 * The decision card's visual vocabulary, shared by `QuestionCard` and
 * `PermissionCard`.
 *
 * Extracted rather than copied: the two cards are the same object in two
 * moods — a session stopped on the user — and every value below was
 * transcribed from canvas 9b/9d for the question card. A permission prompt
 * that invented its own border, chip and row chrome would read as a different
 * product inside the same transcript.
 *
 * There is no artboard for the permission and plan cards yet; when one lands,
 * this is the one file its values change in (spec
 * 2026-09-23-permission-and-plan-decisions-design § Web UI).
 */

/** Canvas 9d COLOUR: the pending card's border, and the accent every row state is built from. */
export const CARD_PENDING =
  'border-accent/28 bg-[linear-gradient(180deg,rgba(10,16,28,.72),rgba(5,9,18,.82))]'
/** Canvas 9d COLOUR: "answered card border — rgba(150,205,255,.12)"; 9b D's quieter fill. */
export const CARD_ANSWERED =
  'border-[rgba(150,205,255,.12)] bg-[linear-gradient(180deg,rgba(10,16,28,.55),rgba(5,9,18,.66))]'
/** Canvas 9b C: the watched-terminal card, quieter again. */
export const CARD_READONLY =
  'border-[rgba(150,205,255,.12)] bg-[linear-gradient(180deg,rgba(10,16,28,.5),rgba(5,9,18,.62))]'

/** Canvas 9b: chip is mono 10 at .14em tracking in a 3px/8px, r4 box. */
export const CHIP_BASE =
  'shrink-0 rounded-[4px] border px-2 py-[3px] font-mono text-[10px] tracking-[0.14em]'
export const CHIP_PENDING = 'border-accent/35 bg-accent/12 text-[oklch(90%_.08_205)]'
export const CHIP_QUIET = 'border-[rgba(150,205,255,.18)] text-[rgba(190,215,240,.7)]'

/** Canvas 9b: the status slot opposite the chip — mono 9.5 at .12em. */
export const STATUS_BASE = 'shrink-0 font-mono text-[9.5px] tracking-[0.12em]'

/** Canvas 9d METRICS: "option row — 9px 11px · r9 · gap 6". */
export const ROW_BASE =
  'flex w-full items-start gap-[9px] rounded-[9px] border px-[11px] py-[9px] text-left transition-[border-color,background-color,box-shadow] duration-[160ms] ease-[ease]'
/** Canvas 9d COLOUR: "row rest — rgba(150,205,255,.14), no fill"; hover adds .34 + .06. */
export const ROW_REST =
  'border-[rgba(150,205,255,.14)] hover:border-[rgba(150,205,255,.34)] hover:bg-[rgba(150,205,255,.06)]'
/** Canvas 9d COLOUR: "row focus — accent/.55 + ring accent/.18". */
export const ROW_FOCUS = 'border-accent/55 bg-accent/8 shadow-[0_0_0_2px_oklch(85%_.12_205_/_.18)]'
/** Canvas 9d COLOUR: "row chosen — accent/.35 + accent/.12". */
export const ROW_CHOSEN = 'border-accent/35 bg-accent/12'
/** Canvas 9d COLOUR: "row locked — .1 border · opacity .55". Applied to the list, per 9b C. */
export const ROW_LOCKED = 'border-[rgba(150,205,255,.1)]'
/** Canvas 9b B: a ticked multiSelect row, quieter than a single-select's chosen row. */
export const ROW_TICKED = 'border-accent/30 bg-accent/10'
/**
 * The expanded free-text row (canvas 9b H). Written out rather than composed
 * from `ROW_BASE`: it needs a different axis and a different gap, and two
 * same-property utilities on one element resolve by stylesheet order rather
 * than by intent (web/CLAUDE.md).
 */
export const ROW_OTHER_OPEN =
  'flex w-full flex-col gap-[7px] rounded-[9px] border border-accent/55 bg-accent/6 px-[11px] py-[9px] shadow-[0_0_0_2px_oklch(85%_.12_205_/_.18)]'

/** Canvas 9d METRICS: "marker gutter — 12px · mono 10 / ✓ 11". */
export const GUTTER = 'w-3 shrink-0 text-center font-mono text-[10px] leading-[1.5]'

/**
 * Canvas 9b: label 13/600/1.3 over description 11.5/1.4, clamped to two lines
 * (9d). Neither carries its ink — each row state sets that, and two
 * same-property utilities on one element resolve by stylesheet order rather
 * than by intent (web/CLAUDE.md).
 */
export const LABEL = 'text-[13px] font-semibold leading-[1.3]'
export const DESCRIPTION = 'line-clamp-2 text-[11.5px] leading-[1.4]'
/** Canvas 9d COLOUR: "label / description ink — #e8eef8 / rgba(160,190,225,.62)". */
export const DESCRIPTION_INK = 'text-[rgba(160,190,225,.62)]'

/**
 * The card shell every decision card wears. `shrink-0` is load-bearing:
 * `overflow-hidden` drops a flex item's automatic min-height to 0, and the
 * transcript is a fixed-height flex column whose content overflows — without
 * it the card is the ONLY child the flex algorithm can crush, and it renders
 * 2px tall (the borders). jsdom cannot catch this; only the browser can.
 */
export const CARD_SHELL =
  'orbital-card-in shrink-0 overflow-hidden rounded-[12px] border transition-[border-color,background-color] duration-200'

/** 9a in situ: a pending card sits on a soft drop shadow in the panel. */
export const CARD_SHADOW = 'shadow-[0_0_0_1px_rgba(0,0,0,.2),0_10px_30px_rgba(0,0,0,.35)]'

/** The card's own padding, so a header and a body agree on the gutter. */
export const CARD_PAD_X = 'px-[13px]'

/** Canvas 9d METRICS: "question type — 13.5px / 600 / 1.45" — the card's headline. */
export const HEADLINE = 'text-[13.5px] font-semibold leading-[1.45] text-pretty'

/** The mono block a card shows raw machine text in (preview, result, plan, input). */
export const MONO_BLOCK =
  'm-0 overflow-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.6] text-[rgba(200,220,245,.88)]'

/** Its frame, and the eyebrow strip above it (canvas 9b A's preview box). */
export const MONO_FRAME =
  'overflow-hidden rounded-[8px] border border-[rgba(150,205,255,.12)] bg-[rgba(3,6,12,.7)]'
export const MONO_EYEBROW =
  'border-b border-[rgba(150,205,255,.08)] px-2.5 py-[7px] font-mono text-[9.5px] tracking-[0.12em] text-[rgba(160,190,225,.55)]'

/**
 * Canvas 9d METRICS: "confirm button — 6px 14px · r8 · 12px 600". The accent
 * form is the affirmative; the quiet form is every other action on the card.
 */
export const BUTTON_BASE =
  'shrink-0 cursor-pointer rounded-[8px] border px-3.5 py-1.5 text-[12px] font-semibold transition-[border-color,background-color] duration-[160ms] ease-[ease] focus:outline-none'
export const BUTTON_ACCENT =
  'border-accent/50 bg-accent/16 text-[#e8eef8] hover:border-accent/80 hover:bg-accent/26'
export const BUTTON_QUIET =
  'border-[rgba(150,205,255,.18)] text-[rgba(200,220,245,.8)] hover:border-[rgba(150,205,255,.38)] hover:bg-[rgba(150,205,255,.06)]'
