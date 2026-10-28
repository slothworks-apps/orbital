import { createContext, useContext, useEffect, useReducer, useRef, useState } from 'react'
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { reviewBeforeSend, useOrbital } from '../store/store'
import {
  FREE_TEXT_CAP,
  activeQuestionIndex,
  answerSends,
  answerShortName,
  canOpen,
  chipLabel,
  confirmLabel,
  cursorLeft,
  cursorOf,
  cursorRight,
  joinSelection,
  selectionCount,
  moveFocus,
  notTakenLine,
  optionIndexForDigit,
  parseResultAnswers,
  readAnswer,
  restingCursor,
  rowCount,
  toggleSelection,
  type AnswerMap,
  type QuestionCursor,
  type ReadAnswer,
} from '../lib/questionCard'
import { useEscapeLayer } from '../ui/escapeLayer'
import { command, isTypingTarget, matches } from '../lib/keymap'
// Every value below was transcribed from canvas 9b/9d and now lives beside
// the permission card that shares it — see `decisionCardStyles`.
import {
  BUTTON_BASE,
  BUTTON_CONFIRM,
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
  HEADLINE,
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
import type { AskUserQuestionInput, ChatMessage, QuestionSpec } from '../lib/types'

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

/**
 * The phone renders the same card (spec 2026-10-21-question-card-go-back-design
 * § Phone; canvas 9i): no hover and no keys there, so answered blocks say
 * CHANGE at all times, the header ticks only display, Keep is a button and
 * Send runs full width. The phone's screens provide `true`.
 */
export const QuestionCardPhoneContext = createContext(false)

export function QuestionCard({ sessionId, toolUse, toolResult, readOnly = false }: QuestionCardProps) {
  const decisionId = toolUse.toolUseId ?? toolUse.id
  const pending = useOrbital((s) => s.pendingDecisions[sessionId])
  const sentAnswers = useOrbital((s) => s.decisionAnswers[decisionId])
  const drafts = useOrbital((s) => s.decisionDrafts[decisionId])
  const session = useOrbital((s) => s.sessions[sessionId])

  const isPending = pending?.id === decisionId
  // The pending decision's own copy of the input wins over the transcript's:
  // it is what the server is actually blocked on.
  const questions = questionsOf(isPending ? pending.input : toolUse.toolInput)

  // What this tab already sent beats the transcript's copy of it — the card
  // flips to its answered form on the click, not on the round trip (9d
  // "answering": no spinner, the send is local). A draft never does: it is
  // not a sent answer.
  // The result's structured answers first; the prose the CLI wrote for the
  // model only when the Mac sent none (an older Mac).
  const resultAnswers = toolResult?.answers ?? parseResultAnswers(toolResult?.text, questions)
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
      ? // Sent from here: the card locks into its answered form at once,
        // before the server's `decision_resolved` arrives.
        sentAnswers && active === -1
        ? 'answered'
        : 'interactive'
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
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap px-[13px] pb-[13px] pt-[9px] font-mono fs-10.5 leading-[1.6] text-[rgba(160,190,225,.75)]">
          {toolResult?.text ?? ''}
        </pre>
      </div>
    )
  }

  if (mode === 'interactive') {
    return (
      <LiveCard
        // A new decision on the same tool call is a new card.
        key={decisionId}
        sessionId={sessionId}
        decisionId={decisionId}
        questions={questions}
        drafts={drafts ?? NO_ANSWERS}
      />
    )
  }

  // The session interrupted or ended with the card unsent: the drafts are
  // shown dimmed under UNANSWERED, never as sent (canvas 9j drafts). Only
  // once the decision has really ended — a result came back, or the session
  // is over; a card answered elsewhere shows its real result instead.
  const unsentDrafts =
    mode === 'locked' &&
    !readOnly &&
    drafts !== undefined &&
    (toolResult !== undefined || session?.status === 'ended')
      ? drafts
      : null

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
        mode === 'terminal' ? CARD_READONLY : CARD_ANSWERED,
      ].join(' ')}
    >
      {/* Multi-question header (canvas 9b F): the progress ticks are the only
          chrome a stacked card adds. */}
      {multi && (
        <div className="flex items-center gap-2 border-b border-[rgba(150,205,255,.08)] px-[13px] pb-[9px] pt-[11px]">
          <span className="font-mono fs-9.5 tracking-[0.14em] text-[rgba(160,190,225,.6)]">
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
          <span className="font-mono fs-9.5 tracking-[0.12em] text-accent/85">
            {answered} / {questions.length}
          </span>
        </div>
      )}

      {questions.map((question, index) => {
        const draft = unsentDrafts?.[question.question]
        return draft !== undefined ? (
          <DraftBlock
            key={question.question}
            question={question}
            answer={draft}
            separated={multi && index < questions.length - 1}
          />
        ) : (
          <QuestionBlock
            key={question.question}
            question={question}
            answer={answers[question.question]}
            answeredTimestamp={toolResult?.timestamp}
            // Only a terminal's first unanswered question is marked as the
            // one waiting; everything else is history.
            state={
              answers[question.question] !== undefined
                ? 'answered'
                : mode === 'terminal' && index === active
                  ? 'terminal'
                  : 'locked'
            }
            settled={unreadableResult !== null && unsentDrafts === null}
            endedUnanswered={
              mode === 'locked' &&
              (unsentDrafts !== null || (unreadableResult === null && session?.status === 'ended'))
            }
            separated={multi && index < questions.length - 1}
            compact={multi}
          />
        )
      })}

      {unreadableResult !== null && unsentDrafts === null && (
        <div className="px-[13px] pb-[13px]">
          <div className="mb-1 font-mono fs-9.5 tracking-[0.16em] text-[rgba(160,190,225,.55)]">
            RESULT
          </div>
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap font-mono fs-10.5 leading-[1.6] text-[rgba(160,190,225,.75)]">
            {unreadableResult}
          </pre>
        </div>
      )}

      {mode === 'terminal' && (
        // Canvas 9b C: 1px dashed .18, the only affordance a watched session
        // offers — it says where the answer has to be typed, not here.
        <div className="mx-[13px] mb-[13px] flex items-center gap-2 rounded-[8px] border border-dashed border-[rgba(150,205,255,.18)] bg-[rgba(3,6,12,.5)] px-2.5 py-2 font-mono fs-10 tracking-[0.06em] text-[rgba(160,190,225,.6)]">
          <span aria-hidden className="text-[rgba(190,215,240,.75)]">
            ▸
          </span>
          answer in the terminal
        </div>
      )}
    </div>
  )
}

const NO_ANSWERS: AnswerMap = {}
const NO_TICKS: string[] = []

/** The status slot's ink on a quiet block (canvas 9e: ANSWERED, UNANSWERED). */
const STATUS_QUIET = 'text-[rgba(160,190,225,.45)]'

/**
 * The pending card this tab can answer (spec
 * 2026-10-21-question-card-go-back-design; canvas 9e–9j). The stack is the
 * map: answered questions sit collapsed to their answer and the whole block
 * reopens it, the first unanswered one is open, the ones after it wait. With
 * every question answered and the review on, a footer offers Send.
 *
 * Which block is open is the store's cursor (`questionCursors`); the answers
 * are drafts (`decisionDrafts`) until Send. This component owns only what
 * belongs to the drawing: unconfirmed multiSelect ticks, whether focus is in
 * the card, and when focus should follow an action.
 */
function LiveCard({
  sessionId,
  decisionId,
  questions,
  drafts,
}: {
  sessionId: string
  decisionId: string
  questions: QuestionSpec[]
  drafts: AnswerMap
}) {
  const storedCursor = useOrbital((s) => s.questionCursors[decisionId])
  const review = useOrbital((s) => reviewBeforeSend(s.settings))
  const answerQuestion = useOrbital((s) => s.answerQuestion)
  const setQuestionCursor = useOrbital((s) => s.setQuestionCursor)
  const sendAnswers = useOrbital((s) => s.sendAnswers)
  const phone = useContext(QuestionCardPhoneContext)

  const cursor = cursorOf(storedCursor, questions, drafts)
  const first = activeQuestionIndex(questions, drafts)
  const multi = questions.length > 1
  const inReview = cursor === 'review'

  /**
   * Ticks given and not yet confirmed, per question. Kept here rather than in
   * the open block so a multiSelect that was open when another question was
   * reopened keeps them (canvas 9f B: "UNANSWERED · 2 TICKED").
   */
  const [ticks, setTicks] = useState<Record<string, string[]>>({})
  const [cardFocused, setCardFocused] = useState(false)
  /** Bumped by an action inside the card: focus follows it to the next open place. */
  const [focusSeq, bumpFocus] = useReducer((n: number) => n + 1, 0)
  const cardRef = useRef<HTMLDivElement>(null)
  const sendRef = useRef<HTMLButtonElement>(null)

  // Canvas 9j "focus": after an answer focus moves to the first row of the
  // next open block, or to Send in the review — so ⏎ ⏎ on the last question
  // is two separate presses. A reopened free-text answer has already put the
  // caret in its field.
  useEffect(() => {
    if (focusSeq === 0) return
    const root = cardRef.current
    if (!root) return
    if (sendRef.current) {
      sendRef.current.focus()
      return
    }
    const open = root.querySelector<HTMLElement>('[data-question-block][data-open]')
    if (!open || open.contains(document.activeElement)) return
    const row =
      open.querySelector<HTMLElement>('[data-question-row][data-chosen]') ??
      open.querySelector<HTMLElement>('[data-question-row]')
    row?.focus()
    // Only what has to come into view scrolls (9j "moving").
    open.scrollIntoView?.({ block: 'nearest' })
  }, [focusSeq])

  /** Opens a question or the review. Reopening a multiSelect brings its ticks back. */
  function go(next: QuestionCursor) {
    if (typeof next === 'number') {
      const question = questions[next]
      const answer = question ? drafts[question.question] : undefined
      if (question?.multiSelect && answer !== undefined) {
        const labels = readAnswer(answer, question).chosen.map((o) => o.label)
        setTicks((current) => ({ ...current, [question.question]: labels }))
      }
    }
    setQuestionCursor(sessionId, next)
    bumpFocus()
  }

  function answer(question: QuestionSpec, text: string) {
    answerQuestion(sessionId, question.question, text)
    setTicks((current) => {
      if (!(question.question in current)) return current
      const next = { ...current }
      delete next[question.question]
      return next
    })
    bumpFocus()
  }

  /** Esc / Keep: back where the card rests, the answer unchanged. */
  function keep() {
    setQuestionCursor(sessionId, restingCursor(questions, drafts))
    bumpFocus()
  }

  function send() {
    sendAnswers(sessionId)
  }

  // Canvas 9j KEYS — only while focus is in the card, never in a text field:
  // the Other… field and the composer keep ←/→ and digits.
  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (phone || e.defaultPrevented || isTypingTarget(e.target)) return
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      if (!inReview) return
      e.preventDefault()
      e.stopPropagation()
      send()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey) {
      e.preventDefault()
      const next =
        e.key === 'ArrowLeft'
          ? cursorLeft(cursor, questions.length)
          : cursorRight(cursor, questions, drafts)
      if (next !== null) go(next)
      return
    }
    if (inReview) {
      // 1–4 in the review change question n — by physical key (keymap rule 2).
      const index = optionIndexForDigit(e, questions.length)
      if (index !== null) {
        e.preventDefault()
        go(index)
      }
    }
  }

  function handleBlur(e: ReactFocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget)) setCardFocused(false)
  }

  return (
    <div
      ref={cardRef}
      data-question-card
      data-mode="interactive"
      role="group"
      aria-label={questions[0].question}
      onKeyDown={handleKeyDown}
      onFocus={() => setCardFocused(true)}
      onBlur={handleBlur}
      className={`${CARD_SHELL} ${CARD_PENDING} ${CARD_SHADOW}`}
    >
      {/* Canvas 9e: the header ticks index the stack; a click on one opens
          that question (desktop only — 9i: display only on the phone). */}
      {multi && (
        <div className="flex items-center gap-2 border-b border-[rgba(150,205,255,.08)] px-[13px] pb-[9px] pt-[11px]">
          <span className="font-mono fs-9.5 tracking-[0.14em] text-[rgba(160,190,225,.6)]">
            {questions.length} QUESTIONS
          </span>
          <span aria-hidden className="flex-1" />
          <span className="flex items-center">
            {questions.map((q, i) => {
              const done = drafts[q.question] !== undefined
              const current = cursor === i
              const openable = !phone && !current && canOpen(i, questions, drafts)
              const bar = (
                <span
                  className={[
                    // 9j: 14×3 r2, current 22×3; done accent/.8, current
                    // accent, ahead .2 — easing width and colour over .2s.
                    'block h-[3px] rounded-[2px] transition-[width,background-color] duration-200 ease-[ease]',
                    current ? 'w-[22px] bg-accent' : 'w-[14px]',
                    current ? '' : done ? 'bg-accent/80' : 'bg-[rgba(150,205,255,.2)]',
                  ].join(' ')}
                />
              )
              return phone ? (
                <span key={q.question} aria-hidden className="flex px-0.5 py-1.5">
                  {bar}
                </span>
              ) : (
                <button
                  key={q.question}
                  type="button"
                  tabIndex={-1}
                  title={`${q.header}${done ? ' · answered' : ''}`}
                  aria-label={`${q.header}${done ? ' · answered' : ''}`}
                  disabled={!openable}
                  onClick={() => go(i)}
                  // 9j: an 18×15 hit area around the 3px tick.
                  className="flex cursor-pointer border-0 bg-transparent px-0.5 py-1.5 disabled:cursor-default"
                >
                  {bar}
                </button>
              )
            })}
          </span>
          <span className="font-mono fs-9.5 tracking-[0.12em] text-accent/85">
            {inReview ? 'REVIEW' : `${cursor + 1} / ${questions.length}`}
          </span>
        </div>
      )}

      {questions.map((question, index) => {
        const drafted = drafts[question.question]
        const separated = index < questions.length - 1 || inReview
        if (cursor === index) {
          return (
            <QuestionBlock
              key={question.question}
              question={question}
              answer={drafted}
              answeredTimestamp={undefined}
              state="live"
              settled={false}
              endedUnanswered={false}
              separated={separated}
              compact={multi}
              live={{
                phone,
                cardFocused,
                ticks: ticks[question.question] ?? NO_TICKS,
                onTicks: (labels) => setTicks((current) => ({ ...current, [question.question]: labels })),
                sends: answerSends(questions, drafts, question, review),
                onAnswer: (text) => answer(question, text),
                onKeep: drafted !== undefined ? keep : undefined,
              }}
            />
          )
        }
        if (drafted !== undefined) {
          return (
            <ReopenBlock
              key={question.question}
              question={question}
              answer={drafted}
              separated={separated}
              inReview={inReview}
              readyToSend={inReview && !multi}
              phone={phone}
              onOpen={() => go(index)}
            />
          )
        }
        return (
          <WaitingBlock
            key={question.question}
            question={question}
            reached={index === first}
            ticked={ticks[question.question]?.length ?? 0}
            separated={separated}
            phone={phone}
            onOpen={() => go(index)}
          />
        )
      })}

      {inReview &&
        (phone ? (
          // Canvas 9i: full width at 50px in the thumb zone, one line under
          // it; the footer's padding, Send's type size and the line's mono
          // size are all 9i's.
          <div className="flex flex-col gap-2 px-[14px] pb-[14px] pt-1">
            <button
              ref={sendRef}
              type="button"
              data-question-send
              onClick={send}
              className="h-fit min-h-[50px] cursor-pointer rounded-[14px] border border-accent/50 bg-accent/16 fs-15 font-semibold text-[#e8eef8]"
            >
              {multi ? 'Send answers' : 'Send answer'}
            </button>
            <span className="text-center font-mono fs-10.5 text-[rgba(160,190,225,.5)]">
              nothing is sent until you tap Send
            </span>
          </div>
        ) : (
          // Canvas 9e: the review footer, 11px 13px 13px, and its "nothing
          // sent yet" line; Send is the confirm button (9d).
          <div className="flex items-center gap-2.5 px-[13px] pb-[13px] pt-[11px]">
            <span className="font-mono fs-10 text-[rgba(160,190,225,.5)]">nothing sent yet</span>
            <span aria-hidden className="flex-1" />
            <button
              ref={sendRef}
              type="button"
              data-question-send
              onClick={send}
              // 9e: the focus ring shows on keyboard focus only.
              className={`${BUTTON_BASE} ${BUTTON_CONFIRM} focus-visible:shadow-[0_0_0_2px_oklch(85%_.12_205_/_.55)]`}
            >
              {multi ? 'Send answers ⌘⏎' : 'Send ⌘⏎'}
            </button>
          </div>
        ))}
    </div>
  )
}

/**
 * A chosen row (canvas 9b D/E, 9e): the accent ✓ beside what was chosen —
 * an option, free text under `YOUR ANSWER`, or a multiSelect's picks.
 */
function ChosenRow({ children }: { children: ReactNode }) {
  return (
    <div className={`${ROW_BASE} ${ROW_CHOSEN}`}>
      <span aria-hidden className="shrink-0 fs-11 leading-[1.5] text-accent">
        ✓
      </span>
      {children}
    </div>
  )
}

/** The mono eyebrow over a chosen row's text (9b E: `YOUR ANSWER`; 9e: `N PICKED`). */
const CHOSEN_EYEBROW = 'font-mono fs-9.5 tracking-[0.12em] text-[rgba(160,190,225,.6)]'

function ChosenOption({ option }: { option: QuestionSpec['options'][number] }) {
  return (
    <ChosenRow>
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className={`${LABEL} text-[#e8eef8]`}>{option.label}</span>
        <span className={`${DESCRIPTION} ${DESCRIPTION_INK} text-pretty`}>{option.description}</span>
      </span>
    </ChosenRow>
  )
}

/** 9b E: free text under its own eyebrow, exact text preserved. */
function ChosenText({ text }: { text: string }) {
  return (
    <ChosenRow>
      <span className="flex min-w-0 flex-col gap-1">
        <span className={CHOSEN_EYEBROW}>YOUR ANSWER</span>
        <span className="fs-13 leading-[1.45] text-pretty text-[#e8eef8]">{text}</span>
      </span>
    </ChosenRow>
  )
}

/**
 * An answer as a collapsed block shows it (canvas 9e): the chosen option with
 * its description, a multiSelect's picks under `N PICKED`, or free text
 * under `YOUR ANSWER`.
 */
function CompactAnswer({ question, answer }: { question: QuestionSpec; answer: string }) {
  const { chosen, other } = readAnswer(answer, question)
  if (question.multiSelect) {
    const lines = [...chosen.map((o) => o.label), ...(other ? [other] : [])]
    return (
      <ChosenRow>
        <span className="flex min-w-0 flex-col gap-1">
          <span className={CHOSEN_EYEBROW}>{lines.length > 0 ? `${lines.length} PICKED` : 'NONE PICKED'}</span>
          {lines.map((line) => (
            <span key={line} className={`${LABEL} text-[#e8eef8]`}>
              {line}
            </span>
          ))}
        </span>
      </ChosenRow>
    )
  }
  return chosen[0] ? <ChosenOption option={chosen[0]} /> : <ChosenText text={answer} />
}

/** The chip and status row every collapsed block opens with (canvas 9e). */
function BlockHead({ question, status }: { question: QuestionSpec; status: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className={`${CHIP_BASE} ${CHIP_QUIET}`}>{chipLabel(question.header)}</span>
      <span aria-hidden className="flex-1" />
      {status}
    </span>
  )
}

/**
 * An answered question of a pending card (canvas 9e/9f A): collapsed to its
 * answer at .72, and the whole block is the control that reopens it. Hover or
 * focus lifts it to 1 and swaps the status for `CHANGE ⏎`; on the phone
 * `CHANGE` shows at all times (9i). In the review every block stands at 1.
 */
function ReopenBlock({
  question,
  answer,
  separated,
  inReview,
  readyToSend,
  phone,
  onOpen,
}: {
  question: QuestionSpec
  answer: string
  separated: boolean
  inReview: boolean
  /** A one-question card in its review: the status reads READY TO SEND (9f C). */
  readyToSend: boolean
  phone: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      data-question-block
      data-question-reopen
      data-state="answered"
      aria-label={`Change ${question.header}`}
      onClick={onOpen}
      className={[
        // 9j: padding 11px 13px 12px; opacity .72 → 1 on hover / focus.
        'group block w-full cursor-pointer border-0 bg-transparent px-[13px] pb-[12px] pt-[11px] text-left text-inherit transition-[opacity,background-color] duration-[160ms] ease-[ease] focus:outline-none',
        // 9j (and 9f's review hover): the faint wash a hovered block takes.
        'hover:bg-[rgba(150,205,255,.035)] focus-visible:bg-[rgba(150,205,255,.035)]',
        inReview ? 'opacity-100' : 'opacity-[.72] hover:opacity-100 focus-visible:opacity-100',
        separated ? 'border-b border-solid border-b-[rgba(150,205,255,.08)]' : '',
      ].join(' ')}
    >
      <BlockHead
        question={question}
        status={
          phone ? (
            <span className={`${STATUS_BASE} text-accent/85`}>CHANGE</span>
          ) : (
            <>
              <span
                className={[
                  STATUS_BASE,
                  'group-hover:hidden group-focus-visible:hidden',
                  readyToSend ? 'text-accent/85' : STATUS_QUIET,
                ].join(' ')}
              >
                {readyToSend ? 'READY TO SEND' : 'ANSWERED'}
              </span>
              <span
                className={`${STATUS_BASE} hidden text-accent/85 group-hover:inline group-focus-visible:inline`}
              >
                CHANGE ⏎
              </span>
            </>
          )
        }
      />
      <span className={`block pb-[9px] pt-[9px] ${HEADLINE} text-[rgba(232,238,248,.85)]`}>
        {question.question}
      </span>
      <CompactAnswer question={question} answer={answer} />
    </button>
  )
}

/**
 * An unanswered question that is not open (canvas 9f A). The first one still
 * without an answer has been reached: it reads UNANSWERED at .6 and opens on
 * a click. One after it is NOT YET at .45 — its chip and question show what
 * is coming, but it cannot be opened or focused.
 */
function WaitingBlock({
  question,
  reached,
  ticked,
  separated,
  phone,
  onOpen,
}: {
  question: QuestionSpec
  reached: boolean
  /** Ticks given in it and not confirmed. */
  ticked: number
  separated: boolean
  phone: boolean
  onOpen: () => void
}) {
  const body = (
    <>
      <BlockHead
        question={question}
        status={
          // 9j: NOT YET sits a step quieter than UNANSWERED.
          <span className={`${STATUS_BASE} ${reached ? STATUS_QUIET : 'text-[rgba(160,190,225,.4)]'}`}>
            {!reached
              ? 'NOT YET'
              : question.multiSelect && ticked > 0
                ? // 9f B / 9i B.
                  phone
                  ? `${ticked} TICKED`
                  : `UNANSWERED · ${ticked} TICKED`
                : 'UNANSWERED'}
          </span>
        }
      />
      <span className={`block pb-[2px] pt-[9px] ${HEADLINE} text-[rgba(232,238,248,.85)]`}>
        {question.question}
      </span>
    </>
  )
  const frame = [
    'block w-full px-[13px] pb-[12px] pt-[11px] text-left',
    separated ? 'border-b border-solid border-b-[rgba(150,205,255,.08)]' : '',
  ].join(' ')
  if (!reached) {
    return (
      <div data-question-block data-state="not-yet" className={`${frame} pointer-events-none opacity-[.45]`}>
        {body}
      </div>
    )
  }
  // 9j: the reached block rests at .6 and lifts to .9 on hover / focus.
  return (
    <button
      type="button"
      data-question-block
      data-state="unanswered"
      onClick={onOpen}
      className={`${frame} cursor-pointer border-x-0 border-t-0 bg-transparent text-inherit opacity-60 transition-[opacity,background-color] duration-[160ms] ease-[ease] hover:opacity-90 focus:outline-none focus-visible:opacity-90`}
    >
      {body}
    </button>
  )
}

/**
 * A draft the session never received (canvas 9j drafts): the session was
 * interrupted or ended with the card unsent. It reads UNANSWERED, its answer
 * at .55 — clearly never sent.
 */
function DraftBlock({
  question,
  answer,
  separated,
}: {
  question: QuestionSpec
  answer: string
  separated: boolean
}) {
  return (
    <div
      data-question-block
      data-state="unsent"
      className={[
        'px-[13px] pb-[12px] pt-[11px]',
        separated ? 'border-b border-[rgba(150,205,255,.08)]' : '',
      ].join(' ')}
    >
      <BlockHead question={question} status={<span className={`${STATUS_BASE} ${STATUS_QUIET}`}>UNANSWERED</span>} />
      <div className={`pb-[9px] pt-[9px] ${HEADLINE} text-[rgba(232,238,248,.85)]`}>
        {question.question}
      </div>
      <div className="opacity-[.55]">
        <CompactAnswer question={question} answer={answer} />
      </div>
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
  /** The open block's wiring — absent on every other state. */
  live?: LiveWiring
}

interface LiveWiring {
  phone: boolean
  cardFocused: boolean
  /** Ticks given and not confirmed (a multiSelect), held by the card. */
  ticks: string[]
  onTicks: (labels: string[]) => void
  /** Whether answering this question sends the card (setting off, the last one). */
  sends: boolean
  onAnswer: (answer: string) => void
  /** Present when the open question already had an answer: esc / Keep returns without a change. */
  onKeep: (() => void) | undefined
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
  live: wiring,
}: QuestionBlockProps) {
  const read = answer === undefined ? undefined : readAnswer(answer, question)
  const freeText = read !== undefined && read.chosen.length === 0

  const status =
    state === 'live' && answer !== undefined
      ? // 9f B: a reopened question is being changed.
        'CHANGING'
      : state === 'answered'
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
      data-open={state === 'live' || undefined}
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
          'fs-13.5 font-semibold leading-[1.45] text-pretty',
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
        <AnsweredBody question={question} answer={answer!} read={read!} />
      ) : live && wiring ? (
        <LiveBody question={question} answer={answer} read={read} {...wiring} />
      ) : (
        <LockedBody question={question} />
      )}
    </div>
  )
}

/**
 * Canvas 9b D/E: the chosen options keep the accent row, the rest become one
 * mono line. A multiSelect answer that also carries Other… text shows both:
 * the ticked rows, then the text under its own eyebrow.
 */
function AnsweredBody({
  question,
  answer,
  read,
}: {
  question: QuestionSpec
  answer: string
  read: ReadAnswer
}) {
  const { chosen, other } = read
  const line = notTakenLine(question.options.length, chosen.length)
  // Nothing chosen: the whole answer is the text (`none` included).
  const text = chosen.length === 0 ? answer : other
  return (
    <div className="flex flex-col gap-1.5">
      {chosen.map((option) => (
        <ChosenOption key={option.label} option={option} />
      ))}
      {text && <ChosenText text={text} />}
      {line && (
        <div className="font-mono fs-10 tracking-[0.04em] text-[rgba(160,190,225,.45)]">
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
 * The open question. Owns which row is focused and whether Other… is
 * expanded; the ticks of a multiSelect belong to the card (they outlive the
 * block when another question is reopened), and the answer goes straight to
 * the store.
 *
 * A reopened question opens on its current answer (canvas 9f B/C): the chosen
 * option marked ✓, a multiSelect with its ticks back, free text back in the
 * Other… field with the caret at its end.
 */
function LiveBody({
  question,
  answer,
  read,
  ticks: selected,
  onTicks,
  sends,
  phone,
  cardFocused,
  onAnswer,
  onKeep,
}: LiveWiring & {
  question: QuestionSpec
  answer: string | undefined
  read: ReadAnswer | undefined
}) {
  const otherIndex = question.options.length
  const chosenLabel = !question.multiSelect ? read?.chosen[0]?.label : undefined
  // A free-text answer (or a multiSelect's added text) comes back in the field.
  const initialOther = read?.other ?? ''
  const [focus, setFocus] = useState(() => {
    if (chosenLabel !== undefined) return question.options.findIndex((o) => o.label === chosenLabel)
    return initialOther ? otherIndex : 0
  })
  const [otherOpen, setOtherOpen] = useState(initialOther !== '')
  const [otherText, setOtherText] = useState(initialOther)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const otherRef = useRef<HTMLTextAreaElement | null>(null)
  /** Esc collapsed the field: put the keyboard back on the row it became. */
  const returnFocus = useRef(false)

  const rows = rowCount(question)

  // Opening the field must land the caret in it — at the end of text that
  // came back with a reopened answer — and closing it must not drop the
  // keyboard on the floor: the row the field collapsed back into is where
  // focus belongs (canvas 9b H: "the other rows stay live the whole time").
  // The ref of an unmounted element is null, which is why this waits for the
  // re-render rather than calling focus() from the key handler.
  useEffect(() => {
    if (otherOpen) {
      const field = otherRef.current
      if (!field) return
      field.focus()
      field.setSelectionRange(field.value.length, field.value.length)
      return
    }
    if (!returnFocus.current) return
    returnFocus.current = false
    rowRefs.current[otherIndex]?.focus()
  }, [otherOpen, otherIndex])

  // Esc peels one thing (canvas 9j KEYS): an expanded Other… collapses back
  // to its row; then, on a reopened question, the answer is kept as it was.
  // Through the app's own escape stack rather than a local key handler: the
  // stack guarantees one press peels exactly ONE layer, and it listens in the
  // capture phase, so a local bubble-phase handler could never win anyway
  // (see ui/escapeLayer). Keep only while focus is in the card — esc
  // elsewhere belongs to whatever has it.
  useEscapeLayer(otherOpen || (onKeep !== undefined && cardFocused && !phone), () => {
    if (otherOpen) {
      returnFocus.current = true
      setFocus(otherIndex)
      setOtherOpen(false)
      setOtherText('')
      return
    }
    onKeep?.()
  })

  function pick(index: number) {
    const option = question.options[index]
    if (!option) return
    if (question.multiSelect) {
      onTicks(toggleSelection(selected, option.label, question.options))
      return
    }
    // Canvas 9b: single-select answers immediately — no confirm step.
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

  const count = selectionCount(selected, otherText)
  const confirm = confirmLabel(count, sends)
  const keepName = answer !== undefined ? answerShortName(answer, question) : ''

  return (
    <div onKeyDown={handleKeyDown}>
      <div className="flex flex-col gap-1.5">
        {question.options.map((option, index) => {
          const ticked = selected.includes(option.label)
          const chosen = option.label === chosenLabel
          const focused = focus === index && !otherOpen
          return (
            <button
              key={option.label}
              type="button"
              data-question-row
              data-chosen={chosen || undefined}
              ref={(el) => {
                rowRefs.current[index] = el
              }}
              aria-pressed={question.multiSelect ? ticked : chosen || undefined}
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
                // 9f B: the current answer of a reopened question stays in
                // its chosen ✓ state; the other rows are live.
                chosen ? ROW_CHOSEN : ticked ? ROW_TICKED : focused ? ROW_FOCUS : ROW_REST,
              ].join(' ')}
            >
              {question.multiSelect ? (
                // Canvas 9d METRICS: "checkbox — 14px · r4 · 1px". It REPLACES
                // the number gutter so a row never means two things at once.
                <span
                  aria-hidden
                  className={[
                    'mt-px grid h-[14px] w-[14px] shrink-0 place-items-center rounded-[4px] border fs-9',
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
                    chosen ? 'fs-11 text-accent' : focused ? 'text-accent' : 'text-[rgba(160,190,225,.45)]',
                  ].join(' ')}
                >
                  {chosen ? '✓' : index + 1}
                </span>
              )}
              <span className="flex min-w-0 flex-col gap-[3px]">
                <span className={[LABEL, focused && !chosen ? 'text-white' : 'text-[#e8eef8]'].join(' ')}>
                  {option.label}
                </span>
                <span
                  className={[
                    DESCRIPTION,
                    'text-pretty',
                    // 9b A: the focused row lifts its description too, .72
                    // against the resting .62.
                    focused && !chosen ? 'text-[rgba(160,190,225,.72)]' : DESCRIPTION_INK,
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
              className="block max-h-40 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 fs-13 leading-[1.45] text-[#e8eef8] caret-accent [field-sizing:content] focus:outline-none"
            />
            <div className="flex items-center gap-2 font-mono fs-10 tracking-[0.06em] text-[rgba(160,190,225,.5)]">
              {/* Canvas 9e: ⏎ answers; on text that came back with a
                  reopened answer it updates it. */}
              {answer !== undefined && initialOther !== '' ? '⏎ update' : '⏎ answer'} · esc back to options
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
              <span className="fs-11.5 leading-[1.4] text-[rgba(160,190,225,.55)]">
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
          <div className="border-b border-[rgba(150,205,255,.08)] px-2.5 py-[7px] font-mono fs-9.5 tracking-[0.12em] text-[rgba(160,190,225,.55)]">
            PREVIEW · {question.options[focus].label.toUpperCase()}
          </div>
          {/* 9d METRICS: "preview max height — 6 lines, then scroll" — six
              lines at this block's own leading, plus its padding. */}
          <pre className="m-0 max-h-[120.8px] overflow-auto whitespace-pre-wrap p-2.5 font-mono fs-10.5 leading-[1.6] text-[rgba(200,220,245,.88)]">
            {question.options[focus].preview}
          </pre>
        </div>
      )}

      {question.multiSelect && (
        // Canvas 9b B: nothing sends until confirm, and zero selections is a
        // real answer — the button never disables. It reads Confirm unless
        // it sends the card (9j).
        <div className="mt-[11px] flex items-center gap-2.5">
          <span className="font-mono fs-10 text-[rgba(160,190,225,.5)]">{count} selected</span>
          <span aria-hidden className="flex-1" />
          <button
            type="button"
            onClick={() => onAnswer(joinSelection(selected, otherText))}
            // 9d METRICS: "confirm button — 6px 14px · r8 · 12px 600".
            className="shrink-0 cursor-pointer rounded-[8px] border border-accent/50 bg-accent/16 px-3.5 py-1.5 fs-12 font-semibold text-[#e8eef8] transition-[border-color,background-color] duration-[160ms] ease-[ease] hover:border-accent/80 hover:bg-accent/26"
          >
            {/* No keys on the phone (9i: "Confirm 2"). */}
            {phone ? confirm.replace(/ ⏎$/, '') : confirm}
          </button>
        </div>
      )}

      {onKeep &&
        (phone ? (
          // Canvas 9i B: Keep replaces esc, with a 44px hit area; the line
          // and Keep's ink are 9i's.
          <div className="flex items-center pt-1.5 font-mono fs-10.5 text-[rgba(160,190,225,.5)]">
            tap another option to change it
            <span aria-hidden className="flex-1" />
            <button
              type="button"
              data-question-keep
              onClick={onKeep}
              className="grid h-fit min-h-11 cursor-pointer place-items-center border-0 bg-transparent px-1 font-mono fs-10.5 text-[rgba(143,216,255,.85)]"
            >
              Keep
            </button>
          </div>
        ) : (
          // Canvas 9e / 9j: "keep link — mono 10 · rgba(143,216,255,.8)";
          // the row's ink, its gap above and the link's hover ink are 9e's.
          <div className="flex items-center gap-2 pt-2.5 font-mono fs-10 text-[rgba(160,190,225,.45)]">
            pick another option to change it
            <span aria-hidden className="flex-1" />
            <button
              type="button"
              data-question-keep
              onClick={onKeep}
              className="cursor-pointer border-0 bg-transparent p-0 font-mono fs-10 tracking-[0.06em] text-[rgba(143,216,255,.8)] hover:text-[#c6ecff]"
            >
              keep “{keepName}” · esc
            </button>
          </div>
        ))}
    </div>
  )
}
