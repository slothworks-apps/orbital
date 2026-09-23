import { useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital, expandDiffOnPermission } from '../store/store'
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
  BUTTON_BASE,
  BUTTON_QUIET,
  CARD_ANSWERED,
  CARD_PAD_X,
  CARD_PENDING,
  CARD_READONLY,
  CARD_SHADOW,
  CARD_SHELL,
  CHIP_BASE,
  CHIP_PENDING,
  CHIP_QUIET,
  DESCRIPTION_INK,
  HEADLINE,
  MONO_BLOCK,
  MONO_EYEBROW,
  MONO_FRAME,
  ROW_OTHER_OPEN,
  STATUS_BASE,
} from './decisionCardStyles'

/**
 * A permission prompt or a plan approval, rendered as the thing it is: a tool
 * call the session is stopped on (spec:
 * 2026-09-23-permission-and-plan-decisions-design).
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
 *   ended while parked): `UNANSWERED`, nothing clickable.
 *
 * Ordinary permission asks leave no trace of having been asked — the CLI
 * records the tool call, not the prompt — so once one settles this card gives
 * way to the transcript's normal tool row. Only `ExitPlanMode` is always a
 * card, because its input IS the plan and a plan is worth reading back.
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
  const status =
    mode === 'interactive'
      ? decision.defaultToNo
        ? 'PENDING · CONFIRM'
        : 'PENDING'
      : mode === 'terminal'
        ? 'PENDING · IN TERMINAL'
        : mode === 'locked'
          ? 'UNANSWERED'
          : approved
            ? decision.kind === 'plan'
              ? 'APPROVED'
              : 'ALLOWED'
            : 'DECLINED'

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
        live ? CARD_SHADOW : '',
      ].join(' ')}
    >
      <div className={`${CARD_PAD_X} pb-[13px] pt-[11px]`}>
        <div className="flex items-center gap-2">
          <span className={`${CHIP_BASE} ${live ? CHIP_PENDING : CHIP_QUIET}`}>
            {decisionChipLabel(decision.kind)}
          </span>
          {decision.toolName && (
            <span className="min-w-0 truncate font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.55)]">
              {decision.toolName}
            </span>
          )}
          <span aria-hidden className="flex-1" />
          <span
            className={[
              STATUS_BASE,
              live
                ? 'text-accent/85'
                : approved || mode !== 'settled'
                  ? 'text-[rgba(160,190,225,.45)]'
                  : 'text-[rgba(235,160,160,.65)]',
            ].join(' ')}
          >
            {status}
          </span>
        </div>

        <div
          className={[
            HEADLINE,
            'pb-[11px] pt-[9px]',
            live ? 'text-[#e8eef8]' : 'text-[rgba(232,238,248,.85)]',
          ].join(' ')}
        >
          {decisionHeadline(decision)}
        </div>

        {decision.description && (
          <div className={`pb-[11px] text-[11.5px] leading-[1.4] ${DESCRIPTION_INK}`}>
            {decision.description}
          </div>
        )}

        {change && (
          <div className={`mb-[11px] ${MONO_FRAME}`}>
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
          <div className={`mb-[11px] ${MONO_FRAME}`}>
            <pre className={`${MONO_BLOCK} max-h-[64px] p-2.5`}>{summary}</pre>
          </div>
        )}

        {plan && (
          <div className={`mb-[11px] ${MONO_FRAME}`}>
            <div className={MONO_EYEBROW}>PLAN</div>
            {/* The plan is the one input worth reading in full, so it gets
                more room than an ordinary tool's detail block before it
                starts scrolling inside itself. */}
            <pre className={`${MONO_BLOCK} max-h-[320px] p-2.5`}>{plan}</pre>
          </div>
        )}

        {detail && !summary && (
          <div className={`mb-[11px] ${MONO_FRAME}`}>
            <div className={MONO_EYEBROW}>INPUT</div>
            <pre className={`${MONO_BLOCK} max-h-[160px] p-2.5`}>{detail}</pre>
          </div>
        )}

        {live && (
          <Verdict
            kind={decision.kind}
            onResolve={(verdict) => resolveDecision(sessionId, verdict)}
          />
        )}

        {mode === 'settled' && !approved && sentVerdict?.message && (
          <>
            <div className="mb-1 font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.55)]">
              YOUR REASON
            </div>
            <div className="text-[13px] leading-[1.45] text-pretty text-[#e8eef8]">
              {sentVerdict.message}
            </div>
          </>
        )}
      </div>

      {mode === 'terminal' && (
        // The same affordance the question card offers a watched session: it
        // says where the answer has to be typed, not here (canvas 9b C).
        <div className="mx-[13px] mb-[13px] flex items-center gap-2 rounded-[8px] border border-dashed border-[rgba(150,205,255,.18)] bg-[rgba(3,6,12,.5)] px-2.5 py-2 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.6)]">
          <span aria-hidden className="text-[rgba(190,215,240,.75)]">
            ▸
          </span>
          answer in the terminal
        </div>
      )}
    </div>
  )
}

/**
 * The two buttons and the reason field behind one of them.
 *
 * Decline comes FIRST in the DOM, so ⇥ lands on the refusal rather than on
 * the approval — the SDK's `defaultToNo` asks for exactly that, and applying
 * it to every ask costs nothing. There is no one-key approve shortcut for the
 * same reason: nothing on this card may be authorised by a stray keystroke.
 */
function Verdict({
  kind,
  onResolve,
}: {
  kind: 'permission' | 'plan'
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

  const declineLabel = kind === 'plan' ? 'Keep planning' : 'Decline'
  const approveLabel = kind === 'plan' ? 'Approve plan' : 'Allow once'

  return (
    <div>
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
      <div className="flex items-center gap-2.5">
        <button
          ref={declineRef}
          type="button"
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
        <button
          type="button"
          onClick={() => onResolve({ approved: true })}
          className={`${BUTTON_BASE} ${BUTTON_ACCENT}`}
        >
          {approveLabel}
        </button>
      </div>
    </div>
  )
}
