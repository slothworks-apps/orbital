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
 * The permission and plan cards now have their own artboard —
 * `Feature - Transcript blocks` 20b, with 20a for the in-situ spacing. The
 * two canvases agree on everything the cards share (shell gradients, chip,
 * status typography), so the tokens above the divider are still 9b/9d's and
 * both cards wear them. Everything below the divider is the permission
 * card's alone, and its values come from 20b/20a.
 *
 * One conflict, left as it stands: 9a gives the pending card's drop shadow an
 * inner `0 0 0 1px rgba(0,0,0,.2)` hairline and 20a does not. `CARD_SHADOW`
 * is shared and the question card is the implemented one, so 9a wins.
 */

/** Canvas 9d COLOUR: the pending card's border, and the accent every row state is built from. */
export const CARD_PENDING =
  'border-accent/28 bg-[linear-gradient(180deg,color-mix(in_oklab,_var(--color-panel)_72%,_transparent),color-mix(in_oklab,_var(--color-space)_82%,_transparent))]'
/** Canvas 9d COLOUR: "answered card border — rgba(150,205,255,.12)"; 9b D's quieter fill. */
export const CARD_ANSWERED =
  'border-line/12 bg-[linear-gradient(180deg,color-mix(in_oklab,_var(--color-panel)_55%,_transparent),color-mix(in_oklab,_var(--color-space)_66%,_transparent))]'
/** Canvas 9b C: the watched-terminal card, quieter again. */
export const CARD_READONLY =
  'border-line/12 bg-[linear-gradient(180deg,color-mix(in_oklab,_var(--color-panel)_50%,_transparent),color-mix(in_oklab,_var(--color-space)_62%,_transparent))]'

/** Canvas 9b: chip is mono 10 at .14em tracking in a 3px/8px, r4 box. */
export const CHIP_BASE =
  'shrink-0 rounded-[4px] border px-2 py-[3px] font-mono fs-10 tracking-[0.14em]'
export const CHIP_PENDING = 'border-accent/35 bg-accent/12 text-[oklch(90%_.08_205)]'
export const CHIP_QUIET = 'border-line/18 text-ink-700/70'

/** Canvas 9b: the status slot opposite the chip — mono 9.5 at .12em. */
export const STATUS_BASE = 'shrink-0 font-mono fs-9.5 tracking-[0.12em]'

/** Canvas 9d METRICS: "option row — 9px 11px · r9 · gap 6". */
export const ROW_BASE =
  'flex w-full items-start gap-[9px] rounded-[9px] border px-[11px] py-[9px] text-left transition-[border-color,background-color,box-shadow] duration-[160ms] ease-[ease]'
/** Canvas 9d COLOUR: "row rest — rgba(150,205,255,.14), no fill"; hover adds .34 + .06. */
export const ROW_REST =
  'border-line/14 hover:border-line/34 hover:bg-line/6'
/** Canvas 9d COLOUR: "row focus — accent/.55 + ring accent/.18". */
export const ROW_FOCUS = 'border-accent/55 bg-accent/8 shadow-[0_0_0_2px_color-mix(in_oklab,var(--color-accent)_18%,transparent)]'
/** Canvas 9d COLOUR: "row chosen — accent/.35 + accent/.12". */
export const ROW_CHOSEN = 'border-accent/35 bg-accent/12'
/** Canvas 9d COLOUR: "row locked — .1 border · opacity .55". Applied to the list, per 9b C. */
export const ROW_LOCKED = 'border-line/10'
/** Canvas 9b B: a ticked multiSelect row, quieter than a single-select's chosen row. */
export const ROW_TICKED = 'border-accent/30 bg-accent/10'
/**
 * The expanded free-text row (canvas 9b H). Written out rather than composed
 * from `ROW_BASE`: it needs a different axis and a different gap, and two
 * same-property utilities on one element resolve by stylesheet order rather
 * than by intent (web/CLAUDE.md).
 */
export const ROW_OTHER_OPEN =
  'flex w-full flex-col gap-[7px] rounded-[9px] border border-accent/55 bg-accent/6 px-[11px] py-[9px] shadow-[0_0_0_2px_color-mix(in_oklab,var(--color-accent)_18%,transparent)]'

/** Canvas 9d METRICS: "marker gutter — 12px · mono 10 / ✓ 11". */
export const GUTTER = 'w-3 shrink-0 text-center font-mono fs-10 leading-[1.5]'

/**
 * Canvas 9b: label 13/600/1.3 over description 11.5/1.4. Neither carries its
 * ink — each row state sets that, and two same-property utilities on one
 * element resolve by stylesheet order rather than by intent (web/CLAUDE.md).
 *
 * Both wrap in full rather than clamp as 9d draws it: an option is a choice
 * the session is stopped on, and a cut description hides what is being
 * chosen. A long unbroken token (a path, a URL) breaks too — the card is
 * `overflow-hidden`, so otherwise it would be clipped at the right edge.
 */
export const LABEL = 'fs-13 font-semibold leading-[1.3] [overflow-wrap:anywhere]'
export const DESCRIPTION = 'fs-11.5 leading-[1.4] [overflow-wrap:anywhere]'
/** Canvas 9d COLOUR: "label / description ink — #e8eef8 / rgba(160,190,225,.62)". */
export const DESCRIPTION_INK = 'text-ink-900/62'

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
export const CARD_SHADOW = 'shadow-[0_0_0_1px_color-mix(in_oklab,_var(--color-shadow)_20%,_transparent),0_10px_30px_color-mix(in_oklab,_var(--color-shadow)_35%,_transparent)]'

/** The card's own padding, so a header and a body agree on the gutter. */
export const CARD_PAD_X = 'px-[13px]'

/** Canvas 9d METRICS / 20b: "question type — 13.5px / 600 / 1.45" — the card's headline. */
export const HEADLINE = 'fs-13.5 font-semibold leading-[1.45] text-pretty'

// ---------------------------------------------------------------------------
// From here down: the permission card's own vocabulary, canvas
// `Feature - Transcript blocks` 20b (states) and 20a (in situ). The question
// card imports only `BUTTON_BASE` (the metrics 20b and 9d share) and its own
// `BUTTON_CONFIRM`, so the rest is free to follow 20b where 20b and 9b/9d
// differ.
// ---------------------------------------------------------------------------

/**
 * Canvas 20b C: the guarded card — a request the bridge asked us to default
 * to "no" on. Neutral, not hue: a brighter ink border plus a double hairline
 * ring. Carries the whole shadow stack rather than composing with
 * `CARD_SHADOW`, because two `box-shadow` utilities on one element resolve by
 * stylesheet order rather than by intent (web/CLAUDE.md).
 */
export const CARD_GUARDED = 'border-ink-100/42'
export const CARD_GUARDED_SHADOW =
  'shadow-[0_0_0_3px_color-mix(in_oklab,_var(--color-ink-100)_5%,_transparent),0_0_0_1px_color-mix(in_oklab,_var(--color-shadow)_20%,_transparent),0_10px_30px_color-mix(in_oklab,_var(--color-shadow)_35%,_transparent)]'

/** Canvas 20b A / 20a: the bridge's subtitle under the headline — 12 / 1.45. */
export const SUBTITLE = 'fs-12 leading-[1.45] text-pretty text-ink-900/70'

/** Canvas 20a: the detail `<pre>` inside a card's input box — mono 10.5 / 1.6. */
export const MONO_BLOCK =
  'm-0 overflow-auto whitespace-pre-wrap font-mono fs-10.5 leading-[1.6] text-ink-500/85'

/** Canvas 20b A/B/C: the summary box — r7, hairline, near-black fill. */
export const MONO_FRAME =
  'overflow-hidden rounded-[7px] border border-line/12 bg-space/70'
/** Canvas 20b H: the same box on a card nobody can answer here — quieter both ways. */
export const MONO_FRAME_QUIET =
  'overflow-hidden rounded-[7px] border border-line/10 bg-space/50'
/** Canvas 20b D: the plan reads as prose, so its box is the larger radius. */
export const PLAN_FRAME =
  'overflow-hidden rounded-[8px] border border-line/12 bg-space/70'
/** Canvas 20a: the hairline above an opened detail, reused as the block's label strip. */
export const MONO_EYEBROW =
  'border-b border-line/8 px-2.5 py-[7px] font-mono fs-9.5 tracking-[0.12em] text-ink-900/55'

/** Canvas 20b D: the line under a block that counts what it holds. */
export const META_LINE = 'font-mono fs-10 text-ink-900/50'

/**
 * Canvas 20b / 20a: the dashed note a card ends on when the answer has to
 * happen somewhere else — a watched terminal (20b H), another window (20b G).
 */
export const NOTE_DASHED =
  'flex items-center gap-2 rounded-[8px] border border-dashed border-line/18 bg-space/50 px-2.5 py-2 font-mono fs-10'

/**
 * Canvas 20b F: the settled card's verdict row. An approval keeps the accent
 * (the control did something) and so reuses `ROW_CHOSEN`; a refusal stays
 * neutral — 20c's rule holds across the whole feature, no hue anywhere.
 */
export const ROW_VERDICT_DENIED = 'border-line/22'

/**
 * Canvas 20b: "6px 14px · r8 · 12px 600" — the same button metrics 9d gives
 * the question card's confirm. The accent form is the affirmative; the quiet
 * form is every other action on the card.
 */
export const BUTTON_BASE =
  'shrink-0 cursor-pointer rounded-[8px] border px-3.5 py-1.5 fs-12 font-semibold transition-[border-color,background-color] duration-[160ms] ease-[ease] focus:outline-none'
export const BUTTON_ACCENT =
  'border-accent/55 bg-accent/16 text-ink-100 shadow-[0_0_0_2px_color-mix(in_oklab,var(--color-accent)_18%,transparent)] hover:border-accent/80 hover:bg-accent/26'
/**
 * Canvas 9d / 9e: the question card's accent button (its review Send) —
 * border .5 and no resting ring, where 20b's `BUTTON_ACCENT` has .55 and one.
 */
export const BUTTON_CONFIRM = 'border-accent/50 bg-accent/16 text-ink-100 hover:border-accent/80 hover:bg-accent/26'
export const BUTTON_QUIET =
  'border-line/22 text-ink-400/90 hover:border-line/40 hover:bg-line/6'
/**
 * A guarded approve that has been armed and is waiting for the second act
 * (canvas `Feature - Transcript blocks` 20b C, its `guardedApprove` tweak:
 * the border and fill both step up from the resting accent form so the
 * changed label is not the only thing saying the button changed state).
 */
export const BUTTON_ACCENT_ARMED =
  'border-accent/80 bg-accent/30 text-ink-100 shadow-[0_0_0_2px_color-mix(in_oklab,var(--color-accent)_18%,transparent)]'
