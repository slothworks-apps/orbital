import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital, expandDiffOnPermission, guardGesture } from '../store/store'
import { describeFileChange } from '../lib/fileEdit'
import { ChangeView, changeSectionLabel } from './DiffView'
import {
  DECLINE_TEXT_CAP,
  decisionChipLabel,
  decisionHeadline,
  inputDetail,
  inputSummary,
  planText,
} from '../lib/decisionCard'
import { useEscapeLayer } from '../ui/escapeLayer'
import { isReadOnly } from '../lib/types'
import type { ChatMessage, PendingVerdictDecision } from '../lib/types'
import {
  BUTTON_ACCENT,
  BUTTON_ACCENT_ARMED,
  BUTTON_BASE,
  BUTTON_QUIET,
  CARD_ANSWERED,
  CARD_GUARDED,
  CARD_GUARDED_SHADOW,
  CARD_PAD_X,
  CARD_PENDING,
  CARD_READONLY,
  CARD_SHADOW,
  CARD_SHELL,
  CHIP_BASE,
  CHIP_PENDING,
  CHIP_QUIET,
  HEADLINE,
  LABEL,
  META_LINE,
  MONO_BLOCK,
  MONO_EYEBROW,
  MONO_FRAME,
  MONO_FRAME_QUIET,
  NOTE_DASHED,
  PLAN_FRAME,
  ROW_BASE,
  ROW_CHOSEN,
  ROW_OTHER_OPEN,
  ROW_VERDICT_DENIED,
  STATUS_BASE,
  SUBTITLE,
} from './decisionCardStyles'

/**
 * A permission prompt or a plan approval, rendered as the thing it is: a tool
 * call the session is stopped on (spec:
 * 2026-09-23-permission-and-plan-decisions-design; canvas
 * `Feature - Transcript blocks` 20b for the states, 20a for the spacing
 * between them in the panel).
 *
 * The question card's sibling, and deliberately its twin — same shell, same
 * chip, same accent, same quiet-when-settled border, all of them imported
 * from `decisionCardStyles` rather than restated here. What differs is only
 * what a verdict is: two buttons and a reason field, instead of a list of
 * options.
 *
 * Four forms:
 *
 * - `interactive` — this tab holds the pending decision and can answer it.
 * - `terminal` — pending, but it belongs to a terminal Orbital only watches;
 *   the same dashed "answer in the terminal" affordance the question card has.
 * - `settled` — the decision is over. A plan card keeps rendering in this
 *   form from its own `tool_result`, which is what makes an old plan readable
 *   in a reloaded transcript.
 * - `locked` — pending with nobody able to answer it here (a session that
 *   ended while parked): `LOCKED`, nothing clickable, and 20b G's dashed note
 *   in place of the buttons.
 *
 * Ordinary permission asks leave no trace of having been asked — the CLI
 * records the tool call, not the prompt — so once one settles this card gives
 * way to the transcript's normal tool row. Only `ExitPlanMode` is always a
 * card, because its input IS the plan and a plan is worth reading back.
 *
 * A request the bridge flagged `defaultToNo` wears 20b C's guard chrome and
 * approves through a brake — held, confirmed twice, or not at all. Which one
 * is the reader's own setting (`permission_guard_gesture`), because how much
 * friction is worth it is not something Orbital can know for someone else.
 * See `ApproveButton`.
 */

export interface PermissionCardProps {
  sessionId: string
  /** The blocked tool_use. Its `toolUseId` IS the decision id. */
  toolUse: ChatMessage
  /** Present once the tool ran (or was refused) — the settled card's source. */
  toolResult?: ChatMessage
}

/** The decision a card renders from when there is no pending one: the transcript's own. */
function fromTranscript(toolUse: ChatMessage): PendingVerdictDecision {
  return {
    id: toolUse.toolUseId ?? toolUse.id,
    kind: toolUse.toolName === 'ExitPlanMode' ? 'plan' : 'permission',
    input: (toolUse.toolInput ?? {}) as Record<string, unknown>,
    createdAt: 0,
    ...(toolUse.toolName ? { toolName: toolUse.toolName } : {}),
  }
}

export function PermissionCard({ sessionId, toolUse, toolResult }: PermissionCardProps) {
  const decisionId = toolUse.toolUseId ?? toolUse.id
  const pending = useOrbital((s) => s.pendingDecisions[sessionId])
  const sentVerdict = useOrbital((s) => s.decisionVerdicts[decisionId])
  const session = useOrbital((s) => s.sessions[sessionId])
  const resolveDecision = useOrbital((s) => s.resolveDecision)

  const isPending = pending?.id === decisionId && pending.kind !== 'question'
  // The pending decision's own copy wins over the transcript's: it is what the
  // server is actually blocked on, and it carries the bridge's prompt copy,
  // which the transcript's tool_use block does not.
  const decision = isPending ? pending : fromTranscript(toolUse)

  const watchedTerminal = session ? isReadOnly(session) : false
  const mode: 'interactive' | 'terminal' | 'settled' | 'locked' = isPending
    ? watchedTerminal
      ? 'terminal'
      : 'interactive'
    : // What this tab already sent beats waiting for the round trip — the card
      // flips on the click, like the question card's answered form.
      sentVerdict !== undefined || toolResult !== undefined
      ? 'settled'
      : session?.status === 'ended'
        ? 'locked'
        : 'settled'

  // Approved unless something says otherwise: this tab's own verdict first,
  // then the result's error flag, which is how a refusal comes back.
  const approved = sentVerdict?.approved ?? toolResult?.isError !== true
  // Canvas 20b writes each state's own words: a card that is stopped on you
  // says so ("WAITING ON YOU"), and one that is stopped on someone else names
  // where.
  const status =
    mode === 'interactive'
      ? 'WAITING ON YOU'
      : mode === 'terminal'
        ? 'WAITING · IN TERMINAL'
        : mode === 'locked'
          ? 'LOCKED'
          : approved
            ? 'APPROVED'
            : 'DENIED'
  // Canvas 20b F/G/H: the status ink is neutral on every settled card. A red
  // "DENIED" would be the one hue in a feature whose whole colour rule is
  // that there is none (20c F) — and it would read as a failure, which a
  // refusal you chose is not.
  const statusInk =
    mode === 'interactive'
      ? 'text-accent/85'
      : mode === 'settled'
        ? 'text-[rgba(160,190,225,.45)]'
        : 'text-[rgba(160,190,225,.5)]'

  const plan = planText(decision.input)
  // An edit you are being asked to approve is shown as the diff it will make,
  // not as its input JSON — being asked to allow a change without being shown
  // it is the case the setting exists to prevent (canvas
  // `Feature - Transcript blocks` 20f). There is no result yet, by definition,
  // so the change is read from the input alone.
  const settings = useOrbital(useShallow((s) => s.settings))
  const change = useMemo(
    () =>
      expandDiffOnPermission(settings)
        ? describeFileChange(decision.toolName, decision.input, undefined, false)
        : null,
    [settings, decision.toolName, decision.input],
  )
  const summary = change ? null : inputSummary(decision.input)
  const detail = plan || change ? null : inputDetail(decision.input)
  const live = mode === 'interactive'
  // Canvas 20b C: the bridge asked us to default to "no" on this one. The
  // guard is neutral, not hue — a brighter ink border and one double hairline
  // ring — and it also puts a brake on the approve button, whose shape is the
  // reader's setting (adr how-hard-it-is-to-say-yes-is-the-readers-choice).
  const guarded = live && decision.defaultToNo === true
  // A card nobody can answer here reads its input at the quieter weight the
  // rest of its chrome already uses (canvas 20b H).
  const frame = mode === 'terminal' ? MONO_FRAME_QUIET : MONO_FRAME

  return (
    <div
      data-permission-card
      data-kind={decision.kind}
      data-mode={mode}
      role="group"
      aria-label={decisionHeadline(decision)}
      className={[
        CARD_SHELL,
        live ? CARD_PENDING : mode === 'terminal' ? CARD_READONLY : CARD_ANSWERED,
        guarded ? CARD_GUARDED : '',
        live ? (guarded ? CARD_GUARDED_SHADOW : CARD_SHADOW) : '',
      ].join(' ')}
    >
      <div className={`${CARD_PAD_X} pb-[13px] pt-[11px]`}>
        <div className="flex items-center gap-2">
          <span className={`${CHIP_BASE} ${live ? CHIP_PENDING : CHIP_QUIET}`}>
            {decisionChipLabel(decision.kind)}
          </span>
          {/* 20b's own chip carries the tool kind (SHELL · WRITE · EDIT · MCP)
              and so needs no second slot for it. `decisionChipLabel` names the
              decision instead, which leaves the tool unsaid — so the name
              stays, at the header's quiet mono weight. */}
          {decision.toolName && (
            <span className="min-w-0 truncate font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.55)]">
              {decision.toolName}
            </span>
          )}
          <span aria-hidden className="flex-1" />
          <span className={`${STATUS_BASE} ${statusInk}`}>{status}</span>
        </div>

        {/* Canvas 20b: 9px above the headline, 3px from it to the subtitle,
            10px from either to the first block. */}
        <div
          className={[
            HEADLINE,
            'pt-[9px]',
            live ? 'text-[#e8eef8]' : 'text-[rgba(232,238,248,.82)]',
          ].join(' ')}
        >
          {decisionHeadline(decision)}
        </div>

        {decision.description && (
          <div className={`pt-[3px] ${SUBTITLE}`}>{decision.description}</div>
        )}

        {change && (
          <div className={`mt-[10px] ${frame}`}>
            <div className={MONO_EYEBROW}>{changeSectionLabel(change, false)}</div>
            {/* Shown whole rather than as the transcript's preview: this is
                the one moment the change has to be read before it happens.
                It scrolls inside the card like the plan block above. */}
            <div className="max-h-[320px] overflow-y-auto p-2.5">
              <ChangeView change={change} />
            </div>
          </div>
        )}

        {summary && !plan && (
          <div className={`mt-[10px] ${frame}`}>
            <pre className={`${MONO_BLOCK} max-h-[64px] p-2.5`}>{summary}</pre>
          </div>
        )}

        {plan && (
          <>
            <div className={`mt-[10px] ${PLAN_FRAME}`}>
              <div className={MONO_EYEBROW}>PLAN</div>
              {/* The plan is the one input worth reading in full, so it gets
                  more room than an ordinary tool's detail block before it
                  starts scrolling inside itself. */}
              <pre className={`${MONO_BLOCK} max-h-[320px] p-2.5`}>{plan}</pre>
            </div>
            {/* Canvas 20b D: the box says how much of the plan it is holding. */}
            <div className={`mt-[6px] ${META_LINE}`}>{planLines(plan)}</div>
          </>
        )}

        {detail && !summary && (
          <div className={`mt-[10px] ${frame}`}>
            <div className={MONO_EYEBROW}>INPUT</div>
            <pre className={`${MONO_BLOCK} max-h-[160px] p-2.5`}>{detail}</pre>
          </div>
        )}

        {live && (
          <Verdict
            kind={decision.kind}
            guarded={guarded}
            onResolve={(verdict) => resolveDecision(sessionId, verdict)}
          />
        )}

        {mode === 'settled' && (
          // Canvas 20b F: a settled card ends on the verdict, said in words
          // rather than only in the header's status. The approval keeps the
          // accent — the control did something — and the refusal stays
          // neutral and carries the exact reason that was sent.
          <div
            // `ROW_BASE` already carries 20b F's metrics — 9px/11px, r9, gap 9
            // — because 9d gave the question card's option rows the same ones.
            // Its `items-start` is 20a's choice for both verdicts; 20b's
            // centred approval is not layered on top, because two
            // `align-items` utilities on one element resolve by stylesheet
            // order rather than by intent (web/CLAUDE.md).
            className={['mt-[10px]', ROW_BASE, approved ? ROW_CHOSEN : ROW_VERDICT_DENIED].join(
              ' ',
            )}
          >
            <span
              aria-hidden
              className={`shrink-0 text-[11px] leading-[1.5] ${
                approved ? 'text-accent' : 'text-[rgba(200,220,245,.8)]'
              }`}
            >
              {approved ? '✓' : '✕'}
            </span>
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className={`${LABEL} text-[#e8eef8]`}>
                {verdictLabel(decision.kind, approved)}
              </span>
              {!approved && sentVerdict?.message && (
                <span className="text-[12px] leading-[1.45] text-pretty text-[rgba(200,220,245,.85)]">
                  {`“${sentVerdict.message}”`}
                </span>
              )}
            </span>
          </div>
        )}

        {mode === 'terminal' && (
          // The same affordance the question card offers a watched session: it
          // says where the answer has to be typed, not here (canvas 20b H).
          <div
            className={`mt-[10px] ${NOTE_DASHED} tracking-[0.06em] text-[rgba(160,190,225,.65)]`}
          >
            <span aria-hidden className="text-[rgba(190,215,240,.75)]">
              ▸
            </span>
            answer in the terminal
          </div>
        )}

        {mode === 'locked' && (
          // Canvas 20b G: the session ended while parked on this, so the ask
          // is over without an answer this transcript can show. Only the lock
          // is known, which is the wording 20b G gives that case.
          <div className={`mt-[10px] ${NOTE_DASHED} tracking-[0.04em] text-[rgba(200,220,245,.8)]`}>
            <span aria-hidden>⊘</span>
            Answered in another window
          </div>
        )}
      </div>
    </div>
  )
}

/** Canvas 20b F: what the settled row calls the verdict, per kind. */
function verdictLabel(kind: 'permission' | 'plan', approved: boolean): string {
  if (kind === 'plan') return approved ? 'Plan approved' : 'Kept planning'
  return approved ? 'Approved' : 'Denied'
}

/** Canvas 20b D's meta line, minus the step count nothing here can derive. */
function planLines(plan: string): string {
  const n = plan.split('\n').length
  return `${n} ${n === 1 ? 'line' : 'lines'}`
}

/**
 * The two buttons and the reason field behind one of them.
 *
 * Deny comes FIRST in the DOM, so ⇥ lands on the refusal rather than on the
 * approval — the SDK's `defaultToNo` asks for exactly that, canvas 20b puts
 * Deny first visually for the same reason, and applying it to every ask costs
 * nothing. There is no one-key approve shortcut: nothing on this card may be
 * authorised by a stray keystroke, which is also why 20b's `Y · N` hint and
 * its `Approve ⏎` suffix are not drawn — a hint for a key that does nothing
 * is worse than no hint.
 */
function Verdict({
  kind,
  guarded,
  onResolve,
}: {
  kind: 'permission' | 'plan'
  /** The bridge asked us to default to no — the approve button grows a brake. */
  guarded: boolean
  onResolve: (verdict: { approved: boolean; message?: string }) => void
}) {
  const [reasonOpen, setReasonOpen] = useState(false)
  const [reason, setReason] = useState('')
  const declineRef = useRef<HTMLButtonElement | null>(null)

  // Esc collapses the field back to the button, through the app's own escape
  // stack — one press peels exactly one layer, and it listens in the capture
  // phase, so a local bubble-phase handler could never win (see ui/escapeLayer).
  useEscapeLayer(reasonOpen, () => {
    setReasonOpen(false)
    setReason('')
    declineRef.current?.focus()
  })

  // Canvas 20b's words. Its third label, `Deny with reason`, belongs to the
  // composer path — there the reason is typed away from the card and the
  // button is the only thing that can send it. Here the open field has its
  // own two ways out (⏎ sends the reason, the button sends without one), so
  // relabelling the button would contradict the line beside it.
  const declineLabel = kind === 'plan' ? 'Keep planning' : 'Deny'
  const approveLabel = kind === 'plan' ? 'Approve plan' : 'Approve'

  return (
    <div className="pt-[12px]">
      {reasonOpen && (
        // The field expands inline, the way the question card's Other… row
        // does — the card never grows a second composer.
        <div className={`mb-[9px] ${ROW_OTHER_OPEN}`}>
          <textarea
            autoFocus
            aria-label={kind === 'plan' ? 'What the plan is missing' : 'Why not'}
            rows={1}
            maxLength={DECLINE_TEXT_CAP}
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, DECLINE_TEXT_CAP))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onResolve({ approved: false, ...(reason.trim() ? { message: reason } : {}) })
              }
            }}
            className="block w-full resize-none border-0 bg-transparent p-0 text-[13px] leading-[1.45] text-[#e8eef8] caret-accent focus:outline-none"
          />
          <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
            ⏎ send · esc back
            <span aria-hidden className="flex-1" />
            <span>
              {reason.length}/{DECLINE_TEXT_CAP}
            </span>
          </div>
        </div>
      )}
      {/* Canvas 20b: the answer row is 8px-gapped, 12px under whatever it
          follows, and always reads Deny · Approve left to right. */}
      <div className="flex items-center gap-2">
        <button
          ref={declineRef}
          type="button"
          data-verdict-secondary
          onClick={() => (reasonOpen ? onResolve({ approved: false }) : setReasonOpen(true))}
          className={`${BUTTON_BASE} ${BUTTON_QUIET}`}
        >
          {declineLabel}
        </button>
        {reasonOpen && (
          <span className="font-mono text-[10px] text-[rgba(160,190,225,.5)]">
            or send it with no reason
          </span>
        )}
        <span aria-hidden className="flex-1" />
        <ApproveButton
          label={approveLabel}
          guarded={guarded}
          onApprove={() => onResolve({ approved: true })}
        />
      </div>
    </div>
  )
}

/** How long a held approval takes, and how long an armed one stays armed. */
const GUARD_HOLD_MS = 900
const GUARD_ARM_MS = 3000
/** How often the fill redraws while a hold is in progress. */
const GUARD_TICK_MS = 30

/**
 * Approve, with as much friction as the reader asked for (canvas
 * `Feature - Transcript blocks` 20b C, and the settings row that chooses
 * between its two gestures).
 *
 * Unguarded asks — every ask the CLI did not flag `defaultToNo` — ignore all
 * of this and approve on the click, whatever the setting says. The setting is
 * about how hard it should be to say yes to the dangerous ones, not about
 * adding a step to the ordinary ones.
 *
 * `hold` is the canvas's gesture: the fill runs left to right and approves at
 * the end, draining if the pointer leaves or lets go early. A pointer gesture
 * has no keyboard equivalent worth inventing, so **from the keyboard `hold`
 * behaves as `confirm`** — one press arms, a second approves. That is a
 * deliberate difference and the reason `confirm` exists as a choice: it is
 * the same for everyone, and a hold is a poor ask of anyone whose hands do
 * not cooperate.
 */
function ApproveButton({
  label,
  guarded,
  onApprove,
}: {
  label: string
  guarded: boolean
  onApprove: () => void
}) {
  const gesture = useOrbital((s) => guardGesture(s.settings))
  const [armed, setArmed] = useState(false)
  const [progress, setProgress] = useState(0)
  const holding = useRef<number | null>(null)
  const armTimer = useRef<number | null>(null)

  const stopHold = () => {
    if (holding.current !== null) window.clearInterval(holding.current)
    holding.current = null
    setProgress(0)
  }

  // Both timers are cleared on unmount: a card settled by another window
  // disappears mid-gesture, and a running interval would then set state on
  // nothing.
  useEffect(() => {
    return () => {
      if (holding.current !== null) window.clearInterval(holding.current)
      if (armTimer.current !== null) window.clearTimeout(armTimer.current)
    }
  }, [])

  const disarm = () => {
    if (armTimer.current !== null) window.clearTimeout(armTimer.current)
    armTimer.current = null
    setArmed(false)
  }

  const arm = () => {
    setArmed(true)
    armTimer.current = window.setTimeout(() => setArmed(false), GUARD_ARM_MS)
  }

  if (!guarded || gesture === 'single') {
    return (
      <button type="button" data-verdict-primary onClick={onApprove} className={`${BUTTON_BASE} ${BUTTON_ACCENT}`}>
        {label}
      </button>
    )
  }

  const twoStep = gesture === 'confirm'

  const beginHold = () => {
    if (twoStep) return
    const started = Date.now()
    holding.current = window.setInterval(() => {
      const ratio = Math.min(1, (Date.now() - started) / GUARD_HOLD_MS)
      setProgress(ratio)
      if (ratio >= 1) {
        stopHold()
        onApprove()
      }
    }, GUARD_TICK_MS)
  }

  return (
    <button
      type="button"
      data-verdict-primary
      // The keyboard path is the two-step one in both gestures — see the note
      // above the component.
      onClick={(e) => {
        // A click that ends a completed hold would approve twice; the pointer
        // path has already resolved by then and unmounted this card.
        if (!twoStep && e.detail > 0 && progress > 0) return
        if (armed) {
          disarm()
          onApprove()
          return
        }
        if (twoStep || e.detail === 0) arm()
      }}
      onPointerDown={twoStep ? undefined : beginHold}
      onPointerUp={twoStep ? undefined : stopHold}
      onPointerLeave={twoStep ? undefined : stopHold}
      onBlur={disarm}
      aria-label={armed ? `${label} — press again to confirm` : label}
      className={`${BUTTON_BASE} ${armed ? BUTTON_ACCENT_ARMED : BUTTON_ACCENT}`}
      style={
        progress > 0
          ? {
              backgroundImage: `linear-gradient(90deg, oklch(85% .12 205 / .34) ${progress * 100}%, transparent ${progress * 100}%)`,
            }
          : undefined
      }
    >
      {armed ? 'Click again to approve' : twoStep ? `${label}…` : label}
    </button>
  )
}
