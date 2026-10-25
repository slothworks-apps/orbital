import type { QuestionOption, QuestionSpec } from './types'
import { digitFromEvent, type KeyboardEventLike } from './keymap'

/**
 * The `QuestionCard`'s state machine, extracted from the component so the
 * rules the spec is actually about — top-down gating, multiSelect assembly,
 * focus movement, completion — are testable without a DOM (spec:
 * 2026-09-20-interactive-decisions-design § Testing).
 *
 * Everything here is pure. The component owns focus/tick state and the
 * store owns the drafted and sent answers and the cursor; this module only
 * says what the next value should be.
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
 * The answer string for a multiSelect question: the ticked labels, then the
 * Other… text when there is any. Other… adds to the selection rather than
 * replacing it — someone who ticks two options and writes a third expects
 * all three to arrive. An empty selection is `NONE_ANSWER`, never an empty
 * string — the model has to be able to tell "none of these" apart from a
 * blank.
 */
export function joinSelection(labels: readonly string[], otherText = ''): string {
  const other = otherText.trim()
  const parts = other ? [...labels, other] : labels
  return parts.length === 0 ? NONE_ANSWER : parts.join(MULTI_SELECT_JOIN)
}

/** How many items a multiSelect confirm sends — the Other… text counts as one. */
export function selectionCount(labels: readonly string[], otherText = ''): number {
  return labels.length + (otherText.trim() ? 1 : 0)
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

/** A stored answer read back: the offered options it names, and its free text. */
export interface ReadAnswer {
  chosen: QuestionOption[]
  /** The Other… text, or `''` when the answer is options only. */
  other: string
}

/**
 * What an answer string says — the answered card's job of reading a stored
 * answer back (canvas 9b D vs E). An answer that names no option is free
 * text: `chosen` is `[]` and the whole string is `other`, which is what puts
 * it under the `YOUR ANSWER` eyebrow instead of in an option row.
 *
 * The whole string is matched against a single label FIRST, so a label that
 * itself contains the join separator still reads back as one chosen option.
 *
 * A multiSelect answer is read as `joinSelection` wrote it: the ticked labels
 * in the options' order, then the Other… text. Labels are consumed as
 * prefixes rather than by splitting, so a label or a text containing the
 * separator survives. A single-select answer is one label or free text,
 * never a mix.
 */
export function readAnswer(answer: string, question: QuestionSpec): ReadAnswer {
  const { options } = question
  const exact = options.find((o) => o.label === answer)
  if (exact) return { chosen: [exact], other: '' }
  if (answer === NONE_ANSWER) return { chosen: [], other: '' }
  if (!question.multiSelect) return { chosen: [], other: answer }

  const chosen: QuestionOption[] = []
  let rest = answer
  for (const option of options) {
    if (rest === option.label) {
      chosen.push(option)
      rest = ''
      break
    }
    if (rest.startsWith(option.label + MULTI_SELECT_JOIN)) {
      chosen.push(option)
      rest = rest.slice(option.label.length + MULTI_SELECT_JOIN.length)
    }
  }
  if (chosen.length === 0) return { chosen: [], other: answer }
  return { chosen, other: rest }
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
 * The answers a historical `tool_result` carries, or null when it carries
 * none this build can read (the card then falls back to rendering the result
 * as plain text, rather than pretending it understood it).
 *
 * The CLI writes the result as prose, not as the `{answers}` envelope the
 * card sends: `Your questions have been answered: "Q1"="A1", "Q2"="A2". You
 * can now continue…` (or `The user answered: …`). Quotes inside a question or
 * an answer are not escaped, so the prose is read against the questions the
 * card already knows rather than split on quotes. A question it cannot find
 * stays unanswered. The envelope is still read first.
 */
export function parseResultAnswers(
  text: string | undefined,
  questions: readonly QuestionSpec[] = [],
): AnswerMap | null {
  if (!text) return null
  return parseEnvelope(text) ?? parseProse(text, questions)
}

function parseEnvelope(text: string): AnswerMap | null {
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

function parseProse(text: string, questions: readonly QuestionSpec[]): AnswerMap | null {
  // Where each question's `"Q"=` opens, in the order the prose lists them.
  const found: { question: string; start: number; from: number }[] = []
  let cursor = 0
  for (const { question } of questions) {
    const marker = `"${question}"=`
    const at = text.indexOf(marker, cursor)
    if (at === -1) continue
    found.push({ question, start: at, from: at + marker.length })
    cursor = at + marker.length
  }
  const out: AnswerMap = {}
  found.forEach(({ question, from }, i) => {
    const last = i + 1 === found.length
    const segment = text.slice(from, last ? text.length : found[i + 1].start)
    const answer = proseAnswer(segment, last)
    if (answer) out[question] = answer
  })
  return Object.keys(out).length > 0 ? out : null
}

/**
 * One answer out of the prose after its `"Q"=`, up to the next question or
 * the end. The closing sentence carries no quote and no `. ` of its own.
 */
function proseAnswer(segment: string, last: boolean): string | null {
  // An answer in the terminal can name no option and carry only notes:
  // `=(no option selected) notes: …` — those notes are what was answered.
  if (segment.startsWith(NO_OPTION_PREFIX)) {
    const notes = segment.slice(NO_OPTION_PREFIX.length)
    const end = last ? notes.lastIndexOf('. ') : notes.lastIndexOf(', ')
    return (end === -1 ? notes : notes.slice(0, end)).trim() || null
  }
  if (!segment.startsWith('"')) return null
  // A chosen option the terminal showed a preview or took notes for is
  // followed by them; the answer ends at the quote before.
  const tail = PROSE_TAILS.map((t) => segment.indexOf(t, 1)).filter((at) => at !== -1)
  const close = tail.length > 0 ? Math.min(...tail) : segment.lastIndexOf('"')
  return close > 0 ? segment.slice(1, close) : null
}

const NO_OPTION_PREFIX = '(no option selected) notes: '
const PROSE_TAILS = ['" selected preview:', '" notes:', '" user notes:']

/**
 * The multiSelect confirm's copy (canvas 9b B: "Send 2 ⏎" / "Send none ⏎").
 * It reads `Confirm` when confirming does not send the card (canvas 9j:
 * "Confirm n ⏎ · Send n ⏎ only if it sends").
 */
export function confirmLabel(selectedCount: number, sends = true): string {
  const verb = sends ? 'Send' : 'Confirm'
  return selectedCount === 0 ? `${verb} none ⏎` : `${verb} ${selectedCount} ⏎`
}

// ---------------------------------------------------------------------------
// Going back before the card is sent
// (spec 2026-10-21-question-card-go-back-design; canvas 9e–9j).
// ---------------------------------------------------------------------------

/**
 * Which part of a pending card is open: one question by its index, or the
 * review of every answer. Kept per decision, separate from the answers —
 * after a question is reopened the open one is no longer "the first
 * unanswered".
 */
export type QuestionCursor = number | 'review'

/**
 * Where the card rests with these answers and nothing reopened: the first
 * question still without an answer, or the review once every one has one.
 * Also where esc / Keep returns to.
 */
export function restingCursor(questions: readonly QuestionSpec[], answers: AnswerMap): QuestionCursor {
  const first = activeQuestionIndex(questions, answers)
  return first === -1 ? 'review' : first
}

/**
 * True for a question the card may open: an answered one (to change it), or
 * the first one still unanswered. A question after that cannot be opened yet
 * (canvas 9f A: NOT YET).
 */
export function canOpen(
  index: number,
  questions: readonly QuestionSpec[],
  answers: AnswerMap,
): boolean {
  const question = questions[index]
  if (!question) return false
  return answers[question.question] !== undefined || index === activeQuestionIndex(questions, answers)
}

/**
 * The cursor to show: the stored one while it is still a place the card can
 * be (a question it can open, the review only with every answer given), the
 * resting cursor otherwise.
 */
export function cursorOf(
  stored: QuestionCursor | undefined,
  questions: readonly QuestionSpec[],
  answers: AnswerMap,
): QuestionCursor {
  if (stored === 'review') return isComplete(questions, answers) ? 'review' : restingCursor(questions, answers)
  if (typeof stored === 'number' && canOpen(stored, questions, answers)) return stored
  return restingCursor(questions, answers)
}

/** What follows an answer: where the card moves, and whether the card is sent now. */
export interface AfterAnswer {
  cursor: QuestionCursor
  send: boolean
}

/**
 * The rule after any answer, a changed one included: the card moves to the
 * first question still without an answer; once there is none it goes to the
 * review (setting on) or is sent (setting off). So with the setting off,
 * changing an earlier answer while a later question is unanswered never
 * sends — only an answer that completes the card does.
 */
export function afterAnswer(
  questions: readonly QuestionSpec[],
  answers: AnswerMap,
  reviewBeforeSend: boolean,
): AfterAnswer {
  const first = activeQuestionIndex(questions, answers)
  if (first !== -1) return { cursor: first, send: false }
  return { cursor: 'review', send: !reviewBeforeSend }
}

/**
 * Whether answering `question` now would send the card — what makes a
 * multiSelect's confirm read `Send` rather than `Confirm`. Only with the
 * setting off, and only when every other question already has an answer.
 */
export function answerSends(
  questions: readonly QuestionSpec[],
  answers: AnswerMap,
  question: QuestionSpec,
  reviewBeforeSend: boolean,
): boolean {
  if (reviewBeforeSend) return false
  return questions.every((q) => q === question || answers[q.question] !== undefined)
}

/** ← (canvas 9j KEYS): the previous question, opened for change; from the review, the last one. */
export function cursorLeft(cursor: QuestionCursor, questionCount: number): QuestionCursor | null {
  if (cursor === 'review') return questionCount > 0 ? questionCount - 1 : null
  return cursor > 0 ? cursor - 1 : null
}

/**
 * → (canvas 9j KEYS): the next question when it is answered or the first
 * unanswered one; from the last question, the review once every question
 * has an answer.
 */
export function cursorRight(
  cursor: QuestionCursor,
  questions: readonly QuestionSpec[],
  answers: AnswerMap,
): QuestionCursor | null {
  if (cursor === 'review') return null
  const next = cursor + 1
  if (next < questions.length) return canOpen(next, questions, answers) ? next : null
  return isComplete(questions, answers) ? 'review' : null
}

/** What the composer's text would do while a question card is pending. */
export type ComposerTarget =
  /** Answer this question — `changing` when it already had an answer (canvas 9f D). */
  | { kind: 'question'; question: QuestionSpec; changing: boolean }
  /** The review is showing: ⏎ is held, the text waits for Send (canvas 9f D). */
  | { kind: 'review' }

/** The composer's target for a pending, unsent card at `cursor`. */
export function composerTarget(
  questions: readonly QuestionSpec[],
  answers: AnswerMap,
  cursor: QuestionCursor,
): ComposerTarget | null {
  if (questions.length === 0) return null
  if (cursor === 'review') return { kind: 'review' }
  const question = questions[cursor]
  if (!question) return null
  return { kind: 'question', question, changing: answers[question.question] !== undefined }
}

/**
 * The short name of an answer in the reopened block's keep link (canvas 9e:
 * `keep “Header only” · esc`): the option's label, the count of a
 * multiSelect, or "your text".
 */
export function answerShortName(answer: string, question: QuestionSpec): string {
  const { chosen, other } = readAnswer(answer, question)
  if (question.multiSelect) {
    if (answer === NONE_ANSWER) return '0 picked'
    return `${chosen.length + (other ? 1 : 0)} picked`
  }
  return chosen.length === 1 ? chosen[0].label : 'your text'
}
