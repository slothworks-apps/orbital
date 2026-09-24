import type { QuestionOption, QuestionSpec } from './types'
import { digitFromEvent, type KeyboardEventLike } from './keymap'

/**
 * The `QuestionCard`'s state machine, extracted from the component so the
 * rules the spec is actually about — top-down gating, multiSelect assembly,
 * focus movement, completion — are testable without a DOM (spec:
 * 2026-09-20-interactive-decisions-design § Testing).
 *
 * Everything here is pure. The component owns focus/tick/draft state and the
 * store owns the accumulated answers; this module only says what the next
 * value should be.
 */

/** The tool whose calls become a card instead of a `ToolRow`. */
export const QUESTION_TOOL_NAME = 'AskUserQuestion'

/** Canvas 9d METRICS: "free-text cap — 500 chars". */
export const FREE_TEXT_CAP = 500

/** Canvas 9d METRICS: "chip label cap — 12 chars, uppercase". */
export const CHIP_LABEL_CAP = 12

/**
 * What an empty multiSelect sends. Zero selections is a real answer, not a
 * refusal to answer (canvas 9b B: the button stays enabled and reads
 * "Send none ⏎").
 */
export const NONE_ANSWER = 'none'

/** How the ticked labels of a multiSelect are joined into one answer string. */
export const MULTI_SELECT_JOIN = ', '

/** The answers map as the wire carries it: keyed by the EXACT question text. */
export type AnswerMap = Record<string, string>

/** The chip's copy — capped and uppercased (canvas 9d METRICS). */
export function chipLabel(header: string): string {
  return header.trim().slice(0, CHIP_LABEL_CAP).toUpperCase()
}

/**
 * The answer string for a multiSelect question. An empty selection is
 * `NONE_ANSWER`, never an empty string — the model has to be able to tell
 * "none of these" apart from a blank.
 */
export function joinSelection(labels: readonly string[]): string {
  return labels.length === 0 ? NONE_ANSWER : labels.join(MULTI_SELECT_JOIN)
}

/** Ticks/unticks one label, preserving the options' own order. */
export function toggleSelection(
  selected: readonly string[],
  label: string,
  options: readonly QuestionOption[],
): string[] {
  const next = selected.includes(label)
    ? selected.filter((l) => l !== label)
    : [...selected, label]
  const order = options.map((o) => o.label)
  return next.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b))
}

/**
 * Index of the question the card is currently asking — the first one with no
 * answer yet — or `-1` when every question has been answered. This single
 * rule is the whole of the spec's "answered top-down, question n+1 becomes
 * interactive only once n is answered": everything before it renders
 * answered, everything after it renders inert.
 */
export function activeQuestionIndex(
  questions: readonly QuestionSpec[],
  answers: AnswerMap,
): number {
  return questions.findIndex((q) => answers[q.question] === undefined)
}

/** True once every question carries an answer. */
export function isComplete(questions: readonly QuestionSpec[], answers: AnswerMap): boolean {
  return questions.length > 0 && activeQuestionIndex(questions, answers) === -1
}

/**
 * The COMPLETE answers record to POST, or null while any question is still
 * open. Rebuilt from the questions rather than passed through, so the body
 * carries exactly one entry per question and no key the card invented.
 */
export function completedAnswers(
  questions: readonly QuestionSpec[],
  answers: AnswerMap,
): AnswerMap | null {
  if (!isComplete(questions, answers)) return null
  const out: AnswerMap = {}
  for (const q of questions) out[q.question] = answers[q.question]
  return out
}

/** The question a typed composer answer would go to, or undefined when none is open. */
export function openQuestion(
  questions: readonly QuestionSpec[],
  answers: AnswerMap,
): QuestionSpec | undefined {
  const index = activeQuestionIndex(questions, answers)
  return index === -1 ? undefined : questions[index]
}

/**
 * Rows a pending question offers: its options plus the always-present
 * free-text row (canvas 9b: "the model's options are never the whole
 * world"). The Other… row's index is therefore `options.length`.
 */
export function rowCount(question: QuestionSpec): number {
  return question.options.length + 1
}

/** True for the row index that is the Other… row rather than an option. */
export function isOtherRow(question: QuestionSpec, index: number): boolean {
  return index === question.options.length
}

/**
 * Focus movement for ↑ ↓ (canvas 9d KEYS). Wraps, because a list of three
 * rows that stops dead at either end makes the keyboard feel broken; ⇥ is
 * the browser's own and is not routed through here.
 */
export function moveFocus(current: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((current + delta) % count) + count) % count
}

/**
 * The option a `1`–`4` keypress names, or null when the key is not a digit
 * in range (canvas 9d: "1 – 4 · answer that option"). Never resolves to the
 * Other… row — that one is `↩`, not a number.
 *
 * The digit is read by position (`digitFromEvent`, keymap rule 2): on a
 * Czech layout the top row prints `+ ě š č …` without Shift, and the "1" key
 * is what the card's hint means. Shift is allowed for the same reason — a
 * Czech typist may hold it out of habit, and the position does not change.
 * Any other modifier makes the key somebody else's chord, never an answer.
 */
export function optionIndexForDigit(e: KeyboardEventLike, optionCount: number): number | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  const digit = digitFromEvent(e)
  if (digit === null) return null
  const index = digit - 1
  return index < optionCount ? index : null
}

/**
 * Which offered options an answer string names — the answered card's job of
 * reading a stored answer back (canvas 9b D vs E). An answer that matches no
 * option is free text and yields `[]`, which is what puts it under the
 * `YOUR ANSWER` eyebrow instead of in an option row.
 *
 * The whole string is matched against a single label FIRST, so a label that
 * itself contains the join separator still reads back as one chosen option.
 */
export function chosenOptions(
  answer: string,
  options: readonly QuestionOption[],
): QuestionOption[] {
  const exact = options.find((o) => o.label === answer)
  if (exact) return [exact]
  if (answer === NONE_ANSWER) return []
  const parts = answer.split(MULTI_SELECT_JOIN)
  if (parts.length < 2) return []
  const matched = parts.map((part) => options.find((o) => o.label === part))
  return matched.every((o) => o !== undefined) ? (matched) : []
}

/**
 * The mono line under an answered question's chosen row (canvas 9b D/E).
 * A free-text answer took none of them, so every option is "offered"; a
 * chosen option leaves the rest as "other". Empty string when there is
 * nothing left to count, so the caller renders no line at all.
 */
export function notTakenLine(optionCount: number, chosenCount: number): string {
  if (chosenCount === 0) {
    return optionCount === 0 ? '' : `${optionCount} offered options not taken`
  }
  const rest = optionCount - chosenCount
  return rest <= 0 ? '' : `${rest} other options not taken`
}

/**
 * The answers a historical `tool_result` carries, or null when its content is
 * not the JSON envelope the SDK writes back (the card then falls back to
 * rendering the result as plain text, rather than pretending it understood
 * it).
 */
export function parseResultAnswers(text: string | undefined): AnswerMap | null {
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const answers = (parsed as { answers?: unknown }).answers
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null
  const out: AnswerMap = {}
  for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/** The confirm button's copy (canvas 9b B: "Send 2 ⏎" / "Send none ⏎"). */
export function confirmLabel(selectedCount: number): string {
  return selectedCount === 0 ? 'Send none ⏎' : `Send ${selectedCount} ⏎`
}
