import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useOrbital } from '../store/store'
import {
  FREE_TEXT_CAP,
  activeQuestionIndex,
  chipLabel,
  chosenOptions,
  confirmLabel,
  joinSelection,
  selectionCount,
  moveFocus,
  notTakenLine,
  optionIndexForDigit,
  parseResultAnswers,
  rowCount,
  toggleSelection,
  type AnswerMap,
} from '../lib/questionCard'
import { useEscapeLayer } from '../ui/escapeLayer'
import { command, matches } from '../lib/keymap'
// Every value below was transcribed from canvas 9b/9d and now lives beside
// the permission card that shares it — see `decisionCardStyles`.
import {
  CARD_ANSWERED,
  CARD_PENDING,
  CARD_READONLY,
  CARD_SHADOW,
  CARD_SHELL,
  CHIP_BASE,
  CHIP_PENDING,
  CHIP_QUIET,
  DESCRIPTION,
  DESCRIPTION_INK,
  GUTTER,
  LABEL,
  ROW_BASE,
  ROW_CHOSEN,
  ROW_FOCUS,
  ROW_LOCKED,
  ROW_OTHER_OPEN,
  ROW_REST,
  ROW_TICKED,
  STATUS_BASE,
} from './decisionCardStyles'
import { isReadOnly } from '../lib/types'
import type { AskUserQuestionInput, ChatMessage, QuestionOption, QuestionSpec } from '../lib/types'

/**
 * The `AskUserQuestion` tool call, rendered as the thing it is: a decision
 * the session is stopped on (spec: 2026-09-20-interactive-decisions-design;
 * canvas 9a–9d, with 9d's METRICS/COLOUR tables as the source of every value
 * below).
 *
 * One tool call is one card. Inside it 1–4 questions stack and are answered
 * top-down — the gating, the multiSelect assembly and the focus arithmetic
 * all live in `lib/questionCard.ts`, so this file is only the drawing.
 *
 * Four forms, decided by `mode` below:
 *
 * - `interactive` — this tab holds the pending decision and owns the
 *   session's stdin. Rows are buttons, ⏎/↑↓/1–4 work, Other… expands inline.
 * - `terminal` — the question is pending but it belongs to a terminal
 *   Orbital only watches (canvas 9b C): rows at .55, no hover, no cursor, no
 *   focusable child, and the dashed "answer in the terminal" affordance.
 * - `answered` — from this tab's own send or from the historical
 *   `tool_result` (canvas 9b D/E).
 * - `locked` — pending with nobody able to answer it here: a session that
 *   ended while pending reads `UNANSWERED` (canvas 9d).
 *
 * The accent is the composer's panel-interaction accent throughout, never the
 * session's tag hue: hue means tag, this means "a control you can act on".
 */

export interface QuestionCardProps {
  sessionId: string
  /** The `AskUserQuestion` tool_use. Its `toolUseId` IS the decision id. */
  toolUse: ChatMessage
  /** Present once the SDK wrote the answer back — the historical card's source. */
  toolResult?: ChatMessage
  /**
   * Forces the card into its non-interactive forms (`answered` / `locked`)
   * regardless of what `pendingDecisions[sessionId]` says — set by the
   * subagent panel (`TranscriptView`'s own `readOnly` prop), which cannot
   * rely on `isPending` ever being false there.
   *
   * The reason it can't: `decide()` (`server/src/runner/runner.ts`) does not
   * read the SDK's `opts.agentID`, so a subagent whose own toolset happens to
   * include `AskUserQuestion` produces a `decision_pending` on the PARENT's
   * `session:<id>` topic keyed by the SUBAGENT's own `toolUseId` — the exact
   * id this card's `decisionId` computes to when that tool_use is the one
   * `forwardSubagentText` mirrors into the subagent panel. Without this flag,
   * `isPending` would read true and the panel would render a fully
   * interactive card for a decision that also has no visible row anywhere
   * else to answer it from (fix: subagent-question-ignores-agent-id).
   */
  readOnly?: boolean
}

function questionsOf(toolInput: unknown): QuestionSpec[] {
  const input = toolInput as AskUserQuestionInput | undefined
  const questions = input?.questions
  if (!Array.isArray(questions)) return []
  return questions.filter(
    (q): q is QuestionSpec =>
      !!q && typeof q.question === 'string' && Array.isArray(q.options),
  )
}

/** Canvas 9b D: "ANSWERED 14:22" — the result's own clock, when it has one. */
function answeredAt(timestamp: string | undefined): string {
  if (!timestamp) return ''
  const at = new Date(timestamp)
  if (Number.isNaN(at.getTime())) return ''
  return ` ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

export function QuestionCard({ sessionId, toolUse, toolResult, readOnly = false }: QuestionCardProps) {
  const decisionId = toolUse.toolUseId ?? toolUse.id
  const pending = useOrbital((s) => s.pendingDecisions[sessionId])
  const sentAnswers = useOrbital((s) => s.decisionAnswers[decisionId])
  const session = useOrbital((s) => s.sessions[sessionId])
  const answerQuestion = useOrbital((s) => s.answerQuestion)

  const isPending = pending?.id === decisionId
  // The pending decision's own copy of the input wins over the transcript's:
  // it is what the server is actually blocked on.
  const questions = questionsOf(isPending ? pending.input : toolUse.toolInput)

  // What this tab already sent beats the transcript's copy of it — the card
  // flips to its answered form on the click, not on the round trip (9d
  // "answering": no spinner, the send is local).
  const resultAnswers = parseResultAnswers(toolResult?.text)
  const answers: AnswerMap = sentAnswers ?? resultAnswers ?? {}
  // A result whose content is not the SDK's `{answers}` envelope: the card
  // still has to show what came back rather than pretend it understood it.
  const unreadableResult =
    !isPending && !sentAnswers && resultAnswers === null && toolResult?.text ? toolResult.text : null

  const watchedTerminal = session ? isReadOnly(session) : false
  const active = activeQuestionIndex(questions, answers)
  // `readOnly` wins outright, ahead of `isPending` — it exists precisely
  // because `isPending` cannot be trusted to say "nobody can answer this
  // here" on its own (see the prop's own doc). A still-open question renders
  // `locked` (readable, inert — the same body a session-ended-while-pending
  // decision already uses), never `interactive` or `terminal`.
  const mode: 'interactive' | 'terminal' | 'answered' | 'locked' = readOnly
    ? active === -1 && questions.length > 0
      ? 'answered'
      : 'locked'
    : isPending && !watchedTerminal
      ? 'interactive'
      : isPending
        ? 'terminal'
        : active === -1 && questions.length > 0
          ? 'answered'
          : 'locked'

  // A tool call whose input this build cannot read still has to render its
  // result rather than vanish from the transcript.
  if (questions.length === 0) {
    return (
      <div
        data-question-card
        data-mode="unreadable"
        className={`shrink-0 overflow-hidden rounded-[12px] border ${CARD_ANSWERED}`}
      >
        <div className="flex items-center gap-2 px-[13px] pt-[11px]">
          <span className={`${CHIP_BASE} ${CHIP_QUIET}`}>QUESTION</span>
        </div>
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap px-[13px] pb-[13px] pt-[9px] font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.75)]">
          {toolResult?.text ?? ''}
        </pre>
      </div>
    )
  }

  const multi = questions.length > 1
  const answered = questions.filter((q) => answers[q.question] !== undefined).length

  return (
    <div
      data-question-card
      data-mode={mode}
      role="group"
      aria-label={questions[0].question}
      className={[
        // Canvas 9d METRICS: "card radius / border — 12px / 1px"; 9d
        // "answering": the border neutralises over .2s when it is answered.
        CARD_SHELL,
        mode === 'interactive' ? CARD_PENDING : mode === 'terminal' ? CARD_READONLY : CARD_ANSWERED,
        mode === 'interactive' ? CARD_SHADOW : '',
      ].join(' ')}
    >
      {/* Multi-question header (canvas 9b F): the progress ticks are the only
          chrome a stacked card adds. */}
      {multi && (
        <div className="flex items-center gap-2 border-b border-[rgba(150,205,255,.08)] px-[13px] pb-[9px] pt-[11px]">
          <span className="font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.6)]">
            {questions.length} QUESTIONS
          </span>
          <span aria-hidden className="flex-1" />
          <span aria-hidden className="flex items-center gap-1">
            {questions.map((q, i) => (
              <span
                key={q.question}
                // 9b F: 14×3 at r2, done in accent/.8, still-to-come in .2.
                className={[
                  'block h-[3px] w-[14px] rounded-[2px]',
                  i < answered ? 'bg-accent/80' : 'bg-[rgba(150,205,255,.2)]',
                ].join(' ')}
              />
            ))}
          </span>
          <span className="font-mono text-[9.5px] tracking-[0.12em] text-accent/85">
            {answered} / {questions.length}
          </span>
        </div>
      )}

      {questions.map((question, index) => (
        <QuestionBlock
          key={question.question}
          question={question}
          answer={answers[question.question]}
          answeredTimestamp={toolResult?.timestamp}
          // Only the first unanswered question is live, and only when this tab
          // owns the session — everything after it waits its turn.
          state={
            answers[question.question] !== undefined
              ? 'answered'
              : mode === 'interactive' && index === active
                ? 'live'
                : mode === 'terminal' && index === active
                  ? 'terminal'
                  : 'locked'
          }
          settled={unreadableResult !== null}
          endedUnanswered={
            mode === 'locked' && unreadableResult === null && session?.status === 'ended'
          }
          separated={multi && index < questions.length - 1}
          compact={multi}
          onAnswer={(text) => answerQuestion(sessionId, question.question, text)}
        />
      ))}

      {unreadableResult !== null && (
        <div className="px-[13px] pb-[13px]">
          <div className="mb-1 font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.55)]">
            RESULT
          </div>
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap font-mono text-[10.5px] leading-[1.6] text-[rgba(160,190,225,.75)]">
            {unreadableResult}
          </pre>
        </div>
      )}

      {mode === 'terminal' && (
        // Canvas 9b C: 1px dashed .18, the only affordance a watched session
        // offers — it says where the answer has to be typed, not here.
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

interface QuestionBlockProps {
  question: QuestionSpec
  answer: string | undefined
  answeredTimestamp: string | undefined
  state: 'live' | 'terminal' | 'answered' | 'locked'
  /** A result came back that the card could not read as answers. */
  settled: boolean
  endedUnanswered: boolean
  separated: boolean
  /** Inside a stacked card the block owns its own padding (canvas 9b F). */
  compact: boolean
  onAnswer: (answer: string) => void
}

function QuestionBlock({
  question,
  answer,
  answeredTimestamp,
  state,
  settled,
  endedUnanswered,
  separated,
  compact,
  onAnswer,
}: QuestionBlockProps) {
  const chosen = answer === undefined ? [] : chosenOptions(answer, question.options)
  const freeText = answer !== undefined && chosen.length === 0

  const status =
    state === 'answered'
      ? freeText
        ? 'ANSWERED · OTHER'
        : `ANSWERED${compact ? '' : answeredAt(answeredTimestamp)}`
      : state === 'terminal'
        ? 'PENDING · IN TERMINAL'
        : settled
          ? 'ANSWERED'
          : endedUnanswered
            ? 'UNANSWERED'
            : question.multiSelect && state === 'live'
              ? 'PENDING · PICK ANY'
              : 'PENDING'

  const live = state === 'live'

  return (
    <div
      data-question-block
      data-state={state}
      className={[
        'px-[13px] pt-[11px]',
        // 9b F: an answered block inside a stack steps back to .72 and keeps
        // its answer visible.
        state === 'answered' && compact ? 'opacity-[.72]' : '',
        separated ? 'border-b border-[rgba(150,205,255,.08)]' : '',
        state === 'answered' && compact ? 'pb-[12px]' : 'pb-[13px]',
      ].join(' ')}
    >
      {/* Chip + status (canvas 9b): the chip names the question, the slot says
          where it stands. */}
      <div className="flex items-center gap-2">
        <span className={`${CHIP_BASE} ${live ? CHIP_PENDING : CHIP_QUIET}`}>
          {chipLabel(question.header)}
        </span>
        <span aria-hidden className="flex-1" />
        <span
          className={[
            STATUS_BASE,
            live
              ? 'text-accent/85'
              : state === 'terminal'
                ? 'text-[rgba(160,190,225,.5)]'
                : 'text-[rgba(160,190,225,.45)]',
          ].join(' ')}
        >
          {status}
        </span>
      </div>

      {/* Canvas 9d METRICS: "question type — 13.5px / 600 / 1.45". */}
      <div
        className={[
          'text-[13.5px] font-semibold leading-[1.45] text-pretty',
          compact && state === 'answered' ? 'pb-[9px] pt-[9px]' : 'pb-[11px] pt-[9px]',
          live
            ? 'text-[#e8eef8]'
            : state === 'terminal'
              ? 'text-[rgba(232,238,248,.82)]'
              : 'text-[rgba(232,238,248,.85)]',
        ].join(' ')}
      >
        {question.question}
      </div>

      {state === 'answered' ? (
        <AnsweredBody question={question} answer={answer!} chosen={chosen} />
      ) : live ? (
        <LiveBody question={question} onAnswer={onAnswer} />
      ) : (
        <LockedBody question={question} />
      )}
    </div>
  )
}

/** Canvas 9b D/E: the chosen option keeps the accent row, the rest become one mono line. */
function AnsweredBody({
  question,
  answer,
  chosen,
}: {
  question: QuestionSpec
  answer: string
  chosen: QuestionOption[]
}) {
  const line = notTakenLine(question.options.length, chosen.length)
  return (
    <div className="flex flex-col gap-1.5">
      {chosen.length > 0 ? (
        chosen.map((option) => (
          <div key={option.label} className={`${ROW_BASE} ${ROW_CHOSEN}`}>
            <span aria-hidden className="shrink-0 text-[11px] leading-[1.5] text-accent">
              ✓
            </span>
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className={`${LABEL} text-[#e8eef8]`}>{option.label}</span>
              <span className={`${DESCRIPTION} ${DESCRIPTION_INK} text-pretty`}>
                {option.description}
              </span>
            </span>
          </div>
        ))
      ) : (
        // 9b E: free text under its own eyebrow, exact text preserved.
        <div className={`${ROW_BASE} ${ROW_CHOSEN}`}>
          <span aria-hidden className="shrink-0 text-[11px] leading-[1.5] text-accent">
            ✓
          </span>
          <span className="flex min-w-0 flex-col gap-1">
            <span className="font-mono text-[9.5px] tracking-[0.12em] text-[rgba(160,190,225,.6)]">
              YOUR ANSWER
            </span>
            <span className="text-[13px] leading-[1.45] text-pretty text-[#e8eef8]">{answer}</span>
          </span>
        </div>
      )}
      {line && (
        <div className="font-mono text-[10px] tracking-[0.04em] text-[rgba(160,190,225,.45)]">
          {line}
        </div>
      )}
    </div>
  )
}

/**
 * A question nobody here can answer (canvas 9b C, and 9d's "session ends
 * while pending"): the rows are still readable — the question is part of the
 * history — but nothing about them says "click me". No button, no cursor, no
 * focusable child.
 */
function LockedBody({ question }: { question: QuestionSpec }) {
  return (
    <div className="flex flex-col gap-1.5 opacity-[.55]">
      {question.options.map((option, index) => (
        <div key={option.label} className={`${ROW_BASE} ${ROW_LOCKED}`}>
          <span aria-hidden className={`${GUTTER} text-[rgba(160,190,225,.4)]`}>
            {index + 1}
          </span>
          <span className="flex min-w-0 flex-col gap-[3px]">
            <span className={LABEL}>{option.label}</span>
            {/* 9b C: the locked card's description sits a step darker again. */}
            <span className={`${DESCRIPTION} text-[rgba(160,190,225,.58)]`}>
              {option.description}
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * The live question. Owns the three pieces of state the canvas's own demo
 * script owns — which row is focused, which labels are ticked, whether
 * Other… is expanded — and nothing else; the answer itself goes straight to
 * the store.
 */
function LiveBody({
  question,
  onAnswer,
}: {
  question: QuestionSpec
  onAnswer: (answer: string) => void
}) {
  const [focus, setFocus] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherText, setOtherText] = useState('')
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const otherRef = useRef<HTMLTextAreaElement | null>(null)
  /** Esc collapsed the field: put the keyboard back on the row it became. */
  const returnFocus = useRef(false)

  const rows = rowCount(question)
  const otherIndex = question.options.length

  // Opening the field must land the caret in it, and closing it must not drop
  // the keyboard on the floor — the row the field collapsed back into is
  // where focus belongs (canvas 9b H: "the other rows stay live the whole
  // time"). The ref of an unmounted element is null, which is why this waits
  // for the re-render rather than calling focus() from the key handler.
  useEffect(() => {
    if (otherOpen) {
      otherRef.current?.focus()
      return
    }
    if (!returnFocus.current) return
    returnFocus.current = false
    rowRefs.current[otherIndex]?.focus()
  }, [otherOpen, otherIndex])

  // Esc collapses the field back to the row (canvas 9d KEYS). Through the
  // app's own escape stack rather than a local key handler: the stack
  // guarantees one press peels exactly ONE layer, and it listens in the
  // capture phase, so a local bubble-phase handler could never win anyway
  // (see ui/escapeLayer).
  useEscapeLayer(otherOpen, () => {
    returnFocus.current = true
    setFocus(otherIndex)
    setOtherOpen(false)
    setOtherText('')
  })

  function pick(index: number) {
    const option = question.options[index]
    if (!option) return
    if (question.multiSelect) {
      setSelected((current) => toggleSelection(current, option.label, question.options))
      return
    }
    // Canvas 9b: single-select sends immediately — no confirm step.
    onAnswer(option.label)
  }

  function focusRow(next: number) {
    setFocus(next)
    rowRefs.current[next]?.focus()
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    // The expanded Other… field owns every key it gets — digits have to type.
    if (e.target instanceof HTMLTextAreaElement) return

    // `dialogs.move` wants the bare arrow: ⌘↑ is somebody else's chord.
    if (command('dialogs.move').chords.some((chord) => matches(chord, e))) {
      e.preventDefault()
      focusRow(moveFocus(focus, e.key === 'ArrowDown' ? 1 : -1, rows))
      return
    }
    if (e.key === ' ' && !question.multiSelect) {
      // Canvas 9d KEYS: space ticks, and ticking is a multiSelect idea only.
      e.preventDefault()
      return
    }
    const digit = optionIndexForDigit(e, question.options.length)
    if (digit !== null) {
      e.preventDefault()
      pick(digit)
    }
  }

  return (
    <div onKeyDown={handleKeyDown}>
      <div className="flex flex-col gap-1.5">
        {question.options.map((option, index) => {
          const ticked = selected.includes(option.label)
          return (
            <button
              key={option.label}
              type="button"
              data-question-row
              ref={(el) => {
                rowRefs.current[index] = el
              }}
              aria-pressed={question.multiSelect ? ticked : undefined}
              onClick={() => pick(index)}
              // Hover IS focus here, exactly as the canvas's own demo wires it
              // (9a: `onMouseEnter` sets focus) — that is what reveals the
              // preview without the pointer having to take keyboard focus.
              // It deliberately does NOT collapse an open Other…: only esc
              // does that, and a mouse crossing the list must not throw away
              // what someone has typed.
              onMouseEnter={() => setFocus(index)}
              onFocus={() => setFocus(index)}
              className={[
                ROW_BASE,
                'cursor-pointer focus:outline-none',
                ticked ? ROW_TICKED : focus === index && !otherOpen ? ROW_FOCUS : ROW_REST,
              ].join(' ')}
            >
              {question.multiSelect ? (
                // Canvas 9d METRICS: "checkbox — 14px · r4 · 1px". It REPLACES
                // the number gutter so a row never means two things at once.
                <span
                  aria-hidden
                  className={[
                    'mt-px grid h-[14px] w-[14px] shrink-0 place-items-center rounded-[4px] border text-[9px]',
                    ticked
                      ? 'border-accent/70 bg-accent/22 text-[oklch(92%_.09_205)]'
                      : 'border-[rgba(150,205,255,.28)]',
                  ].join(' ')}
                >
                  {ticked ? '✓' : ''}
                </span>
              ) : (
                <span
                  aria-hidden
                  className={[
                    GUTTER,
                    focus === index && !otherOpen
                      ? 'text-accent'
                      : 'text-[rgba(160,190,225,.45)]',
                  ].join(' ')}
                >
                  {index + 1}
                </span>
              )}
              <span className="flex min-w-0 flex-col gap-[3px]">
                <span
                  className={[
                    LABEL,
                    focus === index && !otherOpen ? 'text-white' : 'text-[#e8eef8]',
                  ].join(' ')}
                >
                  {option.label}
                </span>
                <span
                  className={[
                    DESCRIPTION,
                    'text-pretty',
                    // 9b A: the focused row lifts its description too, .72
                    // against the resting .62.
                    focus === index && !otherOpen
                      ? 'text-[rgba(160,190,225,.72)]'
                      : DESCRIPTION_INK,
                  ].join(' ')}
                >
                  {option.description}
                </span>
              </span>
            </button>
          )
        })}

        {otherOpen ? (
          // Canvas 9b H: the ROW becomes the field — the card never grows a
          // second composer. It wears the focus row's own chrome.
          <div className={ROW_OTHER_OPEN}>
            <textarea
              ref={otherRef}
              aria-label={`Answer ${question.header} in your own words`}
              rows={1}
              maxLength={FREE_TEXT_CAP}
              value={otherText}
              onChange={(e) => setOtherText(e.target.value.slice(0, FREE_TEXT_CAP))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (!otherText.trim()) return
                  // In a multiSelect the text joins the ticked options
                  // instead of replacing them.
                  onAnswer(
                    question.multiSelect ? joinSelection(selected, otherText) : otherText,
                  )
                }
              }}
              // Grows with what is written, then scrolls: a long answer
              // wraps instead of running off a single line.
              className="block max-h-40 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[13px] leading-[1.45] text-[#e8eef8] caret-accent [field-sizing:content] focus:outline-none"
            />
            <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
              ⏎ send · esc back to options
              <span aria-hidden className="flex-1" />
              <span>
                {otherText.length}/{FREE_TEXT_CAP}
              </span>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-question-row
            ref={(el) => {
              rowRefs.current[otherIndex] = el
            }}
            onClick={() => {
              setFocus(otherIndex)
              setOtherOpen(true)
            }}
            onMouseEnter={() => setFocus(otherIndex)}
            onFocus={() => setFocus(otherIndex)}
            className={[
              ROW_BASE,
              'cursor-pointer focus:outline-none',
              focus === otherIndex ? ROW_FOCUS : ROW_REST,
            ].join(' ')}
          >
            <span
              aria-hidden
              className={[
                GUTTER,
                focus === otherIndex ? 'text-accent' : 'text-[rgba(160,190,225,.45)]',
              ].join(' ')}
            >
              ↩
            </span>
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className={`${LABEL} text-[rgba(200,220,245,.8)]`}>Other…</span>
              <span className="text-[11.5px] leading-[1.4] text-[rgba(160,190,225,.55)]">
                Answer in your own words — or just type in the composer.
              </span>
            </span>
          </button>
        )}
      </div>

      {/* The preview belongs to the FOCUSED row but renders under the whole
          list (canvas 9b A), so moving focus never reflows the row you are
          aiming at. */}
      {!otherOpen && question.options[focus]?.preview && (
        // 9b A: 11px under the row block, 13px to the card's bottom edge
        // (which the block's own padding pays).
        <div className="mt-[11px] overflow-hidden rounded-[8px] border border-[rgba(150,205,255,.12)] bg-[rgba(3,6,12,.7)]">
          <div className="border-b border-[rgba(150,205,255,.08)] px-2.5 py-[7px] font-mono text-[9.5px] tracking-[0.12em] text-[rgba(160,190,225,.55)]">
            PREVIEW · {question.options[focus].label.toUpperCase()}
          </div>
          {/* 9d METRICS: "preview max height — 6 lines, then scroll" — six
              lines at this block's own leading, plus its padding. */}
          <pre className="m-0 max-h-[120.8px] overflow-auto whitespace-pre-wrap p-2.5 font-mono text-[10.5px] leading-[1.6] text-[rgba(200,220,245,.88)]">
            {question.options[focus].preview}
          </pre>
        </div>
      )}

      {question.multiSelect && (
        // Canvas 9b B: nothing sends until confirm, and zero selections is a
        // real answer — the button never disables.
        <div className="mt-[11px] flex items-center gap-2.5">
          <span className="font-mono text-[10px] text-[rgba(160,190,225,.5)]">
            {selectionCount(selected, otherText)} selected
          </span>
          <span aria-hidden className="flex-1" />
          <button
            type="button"
            onClick={() => onAnswer(joinSelection(selected, otherText))}
            // 9d METRICS: "confirm button — 6px 14px · r8 · 12px 600".
            className="shrink-0 cursor-pointer rounded-[8px] border border-accent/50 bg-accent/16 px-3.5 py-1.5 text-[12px] font-semibold text-[#e8eef8] transition-[border-color,background-color] duration-[160ms] ease-[ease] hover:border-accent/80 hover:bg-accent/26"
          >
            {confirmLabel(selectionCount(selected, otherText))}
          </button>
        </div>
      )}
    </div>
  )
}
