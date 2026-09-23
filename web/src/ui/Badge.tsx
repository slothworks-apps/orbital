import { awaitingSubagentLabel, tagColor } from '../lib/types'
import type { SessionStatus } from '../lib/types'
import type { SubagentTaskState } from '../lib/subagentPanel'

export type BadgeProps =
  | {
      variant: 'status'
      value: SessionStatus
      /** Tag hue tinting a working status's dot (canvas 9d). */
      hue?: number
      /**
       * A server restart cut this session's turn short (spec
       * 2026-09-21-session-autoheal-design). A modifier rather than a status
       * of its own: the session really is waiting for input, and this says
       * why. It reads `INTERRUPTED`, keeps the needs-input label's treatment,
       * and drops the blinking dot — nothing is happening; something stopped.
       */
      interrupted?: boolean
      /**
       * How many subagents this session is waiting on, when that is the only
       * reason it is working (`awaitingSubagentCount`). A modifier on
       * `working` for the same reason `interrupted` is one on `needs_input`:
       * the state is right, and this says what is filling it. It keeps the
       * working label's tint and its blinking dot — something IS happening,
       * just not here.
       */
      awaiting?: number
      /**
       * What a `needs_input` label should say (`parkedLabel`): NEEDS INPUT
       * when something is actually parked on the human, DONE when the turn
       * merely finished. Ignored for every other status. Absent, the label
       * keeps the blunt NEEDS INPUT — the answer for a caller that has no
       * session to ask, such as a legend.
       */
      parked?: string
    }
  | { variant: 'count'; value: number; label?: string }
  | { variant: 'model'; value: string; /** Accent outline + focus ring, for the chip that opens the switcher. */ interactive?: boolean }
  | {
      variant: 'task'
      /** The subagent panel's own header state (spec
       * 2026-09-22-subagent-transcript-panel-design.md § 10, canvas 11c) —
       * see `lib/subagentPanel.ts`'s `taskStateFor`. A different vocabulary
       * from `status` above on purpose: these are task states, not the
       * moon's `SessionStatus`. */
      value: SubagentTaskState
      /**
       * TRUNCATED (canvas 11c): "a modifier, not a state" — composes with
       * all five task states rather than being a sixth one, so it is a flag
       * here rather than a `value` of its own.
       */
      truncated?: boolean
      /**
       * Tag hue tinting the RUNNING badge only (spec
       * 2026-09-22-subagent-transcript-panel-design.md § 8: "Accent is the
       * parent session's tag hue, falling back to `oklch(85% .12 205)`").
       * The other four states keep their own fixed semantic hues — canvas
       * 11c's "RULES ACROSS THE SIX": "hue stays semantic and rare: accent
       * for live, green for a returned report, red for an error, amber for
       * a hole in the record, neutral for a deliberate stop" — so this is
       * ignored for every `value` but `'running'`.
       */
      hue?: number
    }

const statusLabel: Record<SessionStatus, string> = {
  working: 'WORKING',
  needs_input: 'NEEDS INPUT',
  idle: 'IDLE',
  ended: 'ENDED',
}

// Canvas 1b: squared-off mono chips (radius 5px), quiet dark fill.
const baseClass =
  'inline-flex items-center gap-1.5 rounded-[5px] border px-[9px] py-1 font-mono text-[10.5px] tracking-[0.04em]'

/**
 * Canvas 11c's six-up state sheet, verbatim: one badge shell, only the
 * border/fill/ink/dot changing. Hue stays semantic and rare (the sheet's own
 * "RULES ACROSS THE SIX"): accent for live, green for a returned report, red
 * for an error, neutral for a deliberate stop, amber for a hole in the
 * record. Motion is reserved for RUNNING alone — a frozen panel has to read
 * as visibly frozen, which is why nothing else here blinks.
 */
/**
 * The RUNNING tone at a given hue — accent, per canvas 11c, unlike the
 * other four states' fixed semantic colours. A function rather than a table
 * entry because the hue is per-session, not one of a fixed handful.
 */
function runningTone(hue: number) {
  return {
    border: `oklch(85% .12 ${hue} / .45)`,
    bg: `oklch(85% .12 ${hue} / .12)`,
    ink: `oklch(88% .1 ${hue})`,
    dashed: false,
    dot: 'circle' as const,
    dotColor: `oklch(85% .12 ${hue})`,
    glow: true,
    blink: true,
    label: 'RUNNING',
  }
}

const TASK_TONE: Record<
  SubagentTaskState,
  {
    border: string
    bg: string
    ink: string
    dashed?: boolean
    dot: 'circle' | 'square' | 'hollow'
    dotColor: string
    glow?: boolean
    blink?: boolean
    label: string
  }
> = {
  // Overridden per-render by `runningTone` below whenever a `hue` is given —
  // this entry is only the canvas's own default (205), used when the caller
  // has no session hue to pass (a legend, a fixture with no tag).
  running: runningTone(205),
  completed: {
    border: 'oklch(80% .13 150 / .45)',
    bg: 'oklch(80% .13 150 / .12)',
    ink: 'oklch(82% .13 150)',
    dot: 'circle',
    dotColor: 'oklch(80% .13 150)',
    label: 'COMPLETED',
  },
  failed: {
    border: 'oklch(72% .17 25 / .5)',
    bg: 'oklch(72% .17 25 / .12)',
    ink: 'oklch(78% .16 25)',
    dot: 'circle',
    dotColor: 'oklch(72% .17 25)',
    label: 'FAILED',
  },
  // Square-dotted, per canvas 11c: "a choice, not a fault" — the one state
  // that trades the circular dot for a 1px-radius square.
  stopped: {
    border: 'rgba(150,205,255,.2)',
    bg: 'rgba(150,205,255,.05)',
    ink: 'rgba(200,220,245,.8)',
    dot: 'square',
    dotColor: 'rgba(200,220,245,.8)',
    label: 'STOPPED',
  },
  stream_lost: {
    border: 'oklch(80% .13 60 / .6)',
    bg: 'oklch(80% .13 60 / .1)',
    ink: 'oklch(85% .12 60)',
    dashed: true,
    dot: 'hollow',
    dotColor: 'oklch(85% .12 60)',
    label: 'STREAM LOST',
  },
}

export function Badge(props: BadgeProps) {
  if (props.variant === 'status') {
    const { value, hue, interrupted, awaiting = 0, parked } = props
    const busy = value === 'working' || value === 'needs_input'
    // The interrupted label keeps needs-input's white treatment (which is
    // what `tint === undefined` selects below), so the hue tint is dropped
    // along with the dot.
    const tint = busy && !interrupted && hue !== undefined ? tagColor(hue) : undefined
    // The tag hue goes on the DOT only — the label stays the fixed accent, so
    // it reads as one family across tags rather than restating the hue twice.
    const stateClass = tint
      ? 'text-accent'
      : interrupted || value === 'needs_input'
        ? 'text-white'
        : value === 'ended'
          ? 'text-text-muted opacity-60'
          : busy
            ? 'text-text-soft'
            : 'text-text-muted'

    return (
      // Canvas `Feature - Detail header` 9d, row 4: a dot and a mono label as
      // plain text — no border, fill or padding. It replaced canvas 1b's chip.
      <span
        data-variant="status"
        data-status={interrupted ? 'interrupted' : awaiting > 0 ? 'awaiting_subagents' : value}
        className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] tracking-[0.08em] ${stateClass}`}
      >
        {busy && !interrupted && (
          <span
            aria-hidden
            className="orbital-pulse h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: tint ?? 'currentColor', boxShadow: tint ? `0 0 8px ${tint}` : undefined }}
          />
        )}
        {interrupted
          ? 'INTERRUPTED'
          : awaiting > 0
            ? awaitingSubagentLabel(awaiting)
            : value === 'needs_input' && parked
              ? parked
              : statusLabel[value]}
      </span>
    )
  }

  if (props.variant === 'model') {
    // Canvas 4a: the squared mono chip,
    // accent-outlined while it is a control you can open. The `▾` is drawn here (not by the
    // caller) so it can carry its own muted, smaller-than-the-label style and
    // only ever shows up on the interactive (switcher) chip.
    return (
      <span
        data-variant="model"
        className={`${baseClass} ${
          props.interactive
            ? 'border-accent/60 bg-accent/8 text-text-bright shadow-[0_0_0_3px_rgba(89,228,243,.1)]'
            : // The canvas's quiet-chip literal — `border-panel-border` is
              // `.14`, not `.2`, so the token can't stand in for it without
              // the chip reading a shade fainter than the artboard.
              'border-[rgba(150,205,255,.2)] bg-[rgba(4,8,16,.5)] text-[rgba(220,235,255,.85)]'
        }`}
      >
        {props.value}
        {props.interactive && (
          <span aria-hidden className="ml-[7px] text-[9px] text-[rgba(160,190,225,.6)]">
            ▾
          </span>
        )}
      </span>
    )
  }

  if (props.variant === 'task') {
    const tone = props.value === 'running' ? runningTone(props.hue ?? 205) : TASK_TONE[props.value]
    return (
      // Two chips, not one: TRUNCATED is a modifier that composes with any
      // of the five states (canvas 11c), so it is a sibling chip rather than
      // a change to the state chip's own shell.
      <span className="inline-flex items-center gap-[7px]">
        <span
          data-variant="task"
          data-task-state={props.value}
          // Not `baseClass`: canvas 11c's badge is the same shell (5px
          // radius, 9px/4px padding) at different type metrics (9.5px /
          // .16em tracking, against the session badge's 10.5px / .04em) —
          // two classes both setting font-size/tracking would resolve by
          // stylesheet order rather than by which one is meant to win
          // (web/CLAUDE.md), so this is its own literal rather than an
          // override appended to `baseClass`.
          className="inline-flex items-center gap-1.5 rounded-[5px] border px-[9px] py-1 font-mono text-[9.5px] tracking-[0.16em]"
          style={{
            borderColor: tone.border,
            borderStyle: tone.dashed ? 'dashed' : 'solid',
            background: tone.bg,
            color: tone.ink,
          }}
        >
          <span
            aria-hidden
            className={[
              'h-[5px] w-[5px] shrink-0',
              tone.dot === 'square' ? 'rounded-[1px]' : 'rounded-full',
              tone.blink ? 'orbital-pulse' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={
              tone.dot === 'hollow'
                ? { border: `1px solid ${tone.dotColor}`, background: 'transparent' }
                : {
                    background: tone.dotColor,
                    boxShadow: tone.glow ? `0 0 8px ${tone.dotColor}` : undefined,
                  }
            }
          />
          {tone.label}
        </span>
        {props.truncated && (
          <span
            data-truncated
            className="shrink-0 rounded-[4px] border border-[rgba(150,205,255,.26)] bg-[rgba(150,205,255,.07)] px-[7px] py-[3px] font-mono text-[9px] tracking-[0.14em] text-[rgba(210,230,250,.85)]"
          >
            TRUNCATED
          </span>
        )}
      </span>
    )
  }

  return (
    <span data-variant="count" className={`${baseClass} border-panel-border text-text-soft`}>
      {props.value}
      {props.label ? ` ${props.label}` : ''}
    </span>
  )
}
