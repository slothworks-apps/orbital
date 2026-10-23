import { describe, it, expect } from 'vitest'
import type { QuestionSpec } from '../lib/types'
import {
  NONE_ANSWER,
  activeQuestionIndex,
  afterAnswer,
  answerSends,
  answerShortName,
  canOpen,
  composerTarget,
  cursorLeft,
  cursorOf,
  cursorRight,
  restingCursor,
  chipLabel,
  completedAnswers,
  confirmLabel,
  isComplete,
  isOtherRow,
  joinSelection,
  moveFocus,
  notTakenLine,
  optionIndexForDigit,
  parseResultAnswers,
  readAnswer,
  rowCount,
  toggleSelection,
} from '../lib/questionCard'

const OPTIONS = [
  { label: 'In place', description: 'One ALTER.' },
  { label: 'Shadow table', description: 'Write both.' },
  { label: 'Leave it', description: 'Read through a view.' },
]

function question(overrides: Partial<QuestionSpec> = {}): QuestionSpec {
  return {
    question: 'How should the old sessions table be migrated?',
    header: 'Migration',
    options: OPTIONS,
    multiSelect: false,
    ...overrides,
  }
}

const scope = question({ question: 'How far should the fix reach?', header: 'Scope' })
const tests = question({ question: 'And what should I add to the suite?', header: 'Tests' })

describe('chipLabel', () => {
  it('uppercases and caps the header at the chip width', () => {
    expect(chipLabel('Approach')).toBe('APPROACH')
    expect(chipLabel('Database migration plan')).toBe('DATABASE MIG')
    expect(chipLabel('Database migration plan')).toHaveLength(12)
  })
})

describe('joinSelection', () => {
  it('joins ticked labels with a comma and a space', () => {
    expect(joinSelection(['Typecheck', 'Unit tests'])).toBe('Typecheck, Unit tests')
  })

  it('sends "none" for an empty selection rather than an empty string', () => {
    // Zero selections is a real answer (canvas 9b B), and the model has to be
    // able to tell "none of these" apart from a blank.
    expect(joinSelection([])).toBe(NONE_ANSWER)
  })

  it('leaves a single ticked label alone', () => {
    expect(joinSelection(['Typecheck'])).toBe('Typecheck')
  })

  it('appends the Other… text to the ticked labels instead of dropping them', () => {
    expect(joinSelection(['Typecheck', 'Unit tests'], '  e2e too ')).toBe(
      'Typecheck, Unit tests, e2e too',
    )
    expect(joinSelection([], 'only this')).toBe('only this')
    expect(joinSelection(['Typecheck'], '   ')).toBe('Typecheck')
    expect(joinSelection([], '  ')).toBe(NONE_ANSWER)
  })
})

describe('toggleSelection', () => {
  it('ticks and unticks one label', () => {
    expect(toggleSelection([], 'Leave it', OPTIONS)).toEqual(['Leave it'])
    expect(toggleSelection(['Leave it'], 'Leave it', OPTIONS)).toEqual([])
  })

  it('keeps the options own order however the ticks were made', () => {
    const picked = toggleSelection(toggleSelection([], 'Leave it', OPTIONS), 'In place', OPTIONS)
    expect(picked).toEqual(['In place', 'Leave it'])
  })
})

describe('top-down gating', () => {
  const questions = [scope, tests]

  it('the first question is the live one while nothing is answered', () => {
    expect(activeQuestionIndex(questions, {})).toBe(0)
    expect(isComplete(questions, {})).toBe(false)
  })

  it('answering n opens n+1', () => {
    const answers = { [scope.question]: 'Header only' }
    expect(activeQuestionIndex(questions, answers)).toBe(1)
  })

  it('an answer to a LATER question does not open it early', () => {
    // Nothing in the UI can do this, but the gate must be the first unanswered
    // question rather than "the count of answers".
    expect(activeQuestionIndex(questions, { [tests.question]: 'One regression' })).toBe(0)
  })

  it('is complete only once every question carries an answer', () => {
    const answers = { [scope.question]: 'Header only', [tests.question]: 'One regression' }
    expect(activeQuestionIndex(questions, answers)).toBe(-1)
    expect(isComplete(questions, answers)).toBe(true)
  })

  it('an empty question list is never complete', () => {
    expect(isComplete([], {})).toBe(false)
  })
})

describe('completedAnswers', () => {
  it('is null until the last question closes', () => {
    expect(completedAnswers([scope, tests], { [scope.question]: 'Header only' })).toBeNull()
  })

  it('rebuilds one entry per question, keyed by the exact question text', () => {
    const record = completedAnswers([scope, tests], {
      [tests.question]: 'One regression',
      [scope.question]: 'Header only',
      'a key nothing asked for': 'x',
    })
    expect(record).toEqual({
      [scope.question]: 'Header only',
      [tests.question]: 'One regression',
    })
  })

  it('keeps an empty-selection answer, which is a real answer', () => {
    expect(completedAnswers([scope], { [scope.question]: NONE_ANSWER })).toEqual({
      [scope.question]: NONE_ANSWER,
    })
  })
})

describe('rows and focus', () => {
  it('counts the always-present Other… row, which is the last index', () => {
    expect(rowCount(question())).toBe(4)
    expect(isOtherRow(question(), 3)).toBe(true)
    expect(isOtherRow(question(), 2)).toBe(false)
  })

  it('moves focus and wraps at both ends', () => {
    expect(moveFocus(0, 1, 4)).toBe(1)
    expect(moveFocus(3, 1, 4)).toBe(0)
    expect(moveFocus(0, -1, 4)).toBe(3)
  })

  it('never divides by an empty row list', () => {
    expect(moveFocus(0, 1, 0)).toBe(0)
  })
})

describe('optionIndexForDigit', () => {
  /** A bare keypress on the physical key `code`, printing `key`. */
  function press(code: string, key: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) {
    return { code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }
  }

  it('maps 1–4 onto the options in range', () => {
    expect(optionIndexForDigit(press('Digit1', '1'), 3)).toBe(0)
    expect(optionIndexForDigit(press('Digit3', '3'), 3)).toBe(2)
  })

  it('reads the digit by position, so a Czech layout’s top row picks too', () => {
    expect(optionIndexForDigit(press('Digit1', '+'), 3)).toBe(0)
    expect(optionIndexForDigit(press('Digit1', '1', { shiftKey: true }), 3)).toBe(0)
  })

  it('does not pick while ⌘, ⌃ or ⌥ is held — that digit is somebody else’s chord', () => {
    expect(optionIndexForDigit(press('Digit1', '1', { metaKey: true }), 3)).toBeNull()
    expect(optionIndexForDigit(press('Digit1', '1', { ctrlKey: true }), 3)).toBeNull()
    expect(optionIndexForDigit(press('Digit1', '¡', { altKey: true }), 3)).toBeNull()
  })

  it('ignores a digit past the last option and anything that is not one', () => {
    expect(optionIndexForDigit(press('Digit4', '4'), 3)).toBeNull()
    expect(optionIndexForDigit(press('Digit0', '0'), 3)).toBeNull()
    expect(optionIndexForDigit(press('Enter', 'Enter'), 3)).toBeNull()
    expect(optionIndexForDigit(press('KeyA', 'a'), 3)).toBeNull()
  })
})

describe('readAnswer', () => {
  const single = question()
  const multiSelect = question({ multiSelect: true })

  it('reads one clicked label back', () => {
    expect(readAnswer('Shadow table', single)).toEqual({ chosen: [OPTIONS[1]], other: '' })
  })

  it('reads a joined multiSelect answer back in order', () => {
    expect(readAnswer('In place, Leave it', multiSelect)).toEqual({
      chosen: [OPTIONS[0], OPTIONS[2]],
      other: '',
    })
  })

  it('treats free text as taking none of the offered options', () => {
    const text = 'Neither — the wrapper is dead code.'
    expect(readAnswer(text, single)).toEqual({ chosen: [], other: text })
    expect(readAnswer(text, multiSelect)).toEqual({ chosen: [], other: text })
    expect(readAnswer(NONE_ANSWER, multiSelect)).toEqual({ chosen: [], other: '' })
  })

  it('prefers a whole-string label match over splitting it', () => {
    const options = [
      { label: 'Ship now, hold the migration', description: '' },
      { label: 'Ship now', description: '' },
      { label: 'hold the migration', description: '' },
    ]
    expect(readAnswer('Ship now, hold the migration', question({ options, multiSelect: true })))
      .toEqual({ chosen: [options[0]], other: '' })
  })

  it('reads ticked options plus Other… text back as both', () => {
    const answer = joinSelection(['In place', 'Leave it'], 'and a note, with a comma')
    expect(readAnswer(answer, multiSelect)).toEqual({
      chosen: [OPTIONS[0], OPTIONS[2]],
      other: 'and a note, with a comma',
    })
  })

  it('never splits a single-select answer into an option and text', () => {
    const text = 'In place, and also something else'
    expect(readAnswer(text, single)).toEqual({ chosen: [], other: text })
  })
})

describe('notTakenLine', () => {
  it('counts the rest as "other" when an option was chosen', () => {
    expect(notTakenLine(3, 1)).toBe('2 other options not taken')
  })

  it('counts every option as "offered" for a free-text answer', () => {
    expect(notTakenLine(3, 0)).toBe('3 offered options not taken')
  })

  it('says nothing when there is nothing left to count', () => {
    expect(notTakenLine(2, 2)).toBe('')
    expect(notTakenLine(0, 0)).toBe('')
  })
})

describe('parseResultAnswers', () => {
  it('reads the SDK envelope', () => {
    const text = JSON.stringify({ answers: { 'Which fix?': 'Fix the gutter' } })
    expect(parseResultAnswers(text)).toEqual({ 'Which fix?': 'Fix the gutter' })
  })

  it('is null for anything it cannot read, so the card can fall back to plain text', () => {
    expect(parseResultAnswers(undefined)).toBeNull()
    expect(parseResultAnswers('')).toBeNull()
    expect(parseResultAnswers('the user picked option A')).toBeNull()
    expect(parseResultAnswers('[1,2,3]')).toBeNull()
    expect(parseResultAnswers(JSON.stringify({ answers: 'A' }))).toBeNull()
    expect(parseResultAnswers(JSON.stringify({ answers: {} }))).toBeNull()
  })

  it('drops non-string values rather than rendering an object as an answer', () => {
    const text = JSON.stringify({ answers: { a: 'yes', b: { nested: true } } })
    expect(parseResultAnswers(text)).toEqual({ a: 'yes' })
  })
})

describe('confirmLabel', () => {
  it('counts what it will send, and stays sendable with nothing ticked', () => {
    expect(confirmLabel(2)).toBe('Send 2 ⏎')
    expect(confirmLabel(0)).toBe('Send none ⏎')
  })

  it('reads Confirm when confirming does not send the card', () => {
    expect(confirmLabel(2, false)).toBe('Confirm 2 ⏎')
    expect(confirmLabel(0, false)).toBe('Confirm none ⏎')
  })
})

// Spec 2026-10-21-question-card-go-back-design § Behaviour / § Testing.
describe('going back before the card is sent', () => {
  const notes = question({ question: 'Anything the reviewer should know?', header: 'Notes' })
  const three = [scope, tests, notes]
  const a = (...entries: Array<[QuestionSpec, string]>) =>
    Object.fromEntries(entries.map(([q, text]) => [q.question, text]))

  describe('afterAnswer', () => {
    it('moves to the first question still without an answer', () => {
      expect(afterAnswer(three, a([scope, 'In place']), true)).toEqual({ cursor: 1, send: false })
      expect(afterAnswer(three, a([scope, 'In place']), false)).toEqual({ cursor: 1, send: false })
    })

    it('goes back to the unanswered question after a reopened one is changed', () => {
      // Q1 and Q3 answered, Q2 not: changing Q1 returns to Q2, not past it.
      const answers = a([scope, 'Leave it'], [notes, 'none'])
      expect(afterAnswer(three, answers, false)).toEqual({ cursor: 1, send: false })
    })

    it('with the review on, completing the card opens the review and sends nothing', () => {
      const answers = a([scope, 'In place'], [tests, 'x'], [notes, 'y'])
      expect(afterAnswer(three, answers, true)).toEqual({ cursor: 'review', send: false })
      expect(afterAnswer([scope], a([scope, 'In place']), true)).toEqual({ cursor: 'review', send: false })
    })

    it('with the review off, only the answer that completes the card sends it', () => {
      const answers = a([scope, 'In place'], [tests, 'x'], [notes, 'y'])
      expect(afterAnswer(three, answers, false)).toEqual({ cursor: 'review', send: true })
      expect(afterAnswer([scope], a([scope, 'In place']), false).send).toBe(true)
    })
  })

  describe('answerSends', () => {
    it('is false with the review on, whatever is answered', () => {
      expect(answerSends([scope], {}, scope, true)).toBe(false)
    })

    it('is true with the review off only when every other question has an answer', () => {
      expect(answerSends(three, a([scope, 'x'], [tests, 'y']), notes, false)).toBe(true)
      // Re-answering Q1 while Q3 is still open must not send.
      expect(answerSends(three, a([scope, 'x'], [tests, 'y']), scope, false)).toBe(false)
      expect(answerSends([scope], {}, scope, false)).toBe(true)
    })
  })

  describe('canOpen and cursorOf', () => {
    it('opens an answered question or the first unanswered one, never one after it', () => {
      const answers = a([scope, 'x'])
      expect(canOpen(0, three, answers)).toBe(true)
      expect(canOpen(1, three, answers)).toBe(true)
      expect(canOpen(2, three, answers)).toBe(false)
      expect(canOpen(3, three, answers)).toBe(false)
    })

    it('rests on the first unanswered question, or the review once all are answered', () => {
      expect(restingCursor(three, {})).toBe(0)
      expect(restingCursor(three, a([scope, 'x'], [tests, 'y'], [notes, 'z']))).toBe('review')
    })

    it('keeps a stored cursor only where the card can be', () => {
      const answers = a([scope, 'x'])
      expect(cursorOf(0, three, answers)).toBe(0)
      expect(cursorOf(2, three, answers)).toBe(1)
      expect(cursorOf('review', three, answers)).toBe(1)
      expect(cursorOf(undefined, three, answers)).toBe(1)
    })
  })

  describe('← and →', () => {
    const all = a([scope, 'x'], [tests, 'y'], [notes, 'z'])

    it('← opens the previous question; from the review, the last one', () => {
      expect(cursorLeft(1, 3)).toBe(0)
      expect(cursorLeft(0, 3)).toBeNull()
      expect(cursorLeft('review', 3)).toBe(2)
    })

    it('→ opens the next answered or first unanswered question, never one after it', () => {
      expect(cursorRight(0, three, a([scope, 'x']))).toBe(1)
      expect(cursorRight(1, three, a([scope, 'x']))).toBeNull()
      expect(cursorRight(0, three, a([scope, 'x'], [notes, 'z']))).toBe(1)
    })

    it('→ from the last question opens the review only once every question is answered', () => {
      expect(cursorRight(2, three, all)).toBe('review')
      expect(cursorRight(2, three, a([scope, 'x'], [notes, 'z']))).toBeNull()
      expect(cursorRight('review', three, all)).toBeNull()
    })
  })

  describe('composerTarget', () => {
    it('answers the open question, and says when that changes an answer', () => {
      expect(composerTarget(three, a([scope, 'x']), 1)).toEqual({ kind: 'question', question: tests, changing: false })
      expect(composerTarget(three, a([scope, 'x']), 0)).toEqual({ kind: 'question', question: scope, changing: true })
    })

    it('is the review while the review shows', () => {
      expect(composerTarget(three, a([scope, 'x'], [tests, 'y'], [notes, 'z']), 'review')).toEqual({ kind: 'review' })
    })
  })

  describe('answerShortName', () => {
    it("names the option, the count of picks, or the user's text", () => {
      expect(answerShortName('In place', scope)).toBe('In place')
      expect(answerShortName('just the header', scope)).toBe('your text')
      const multi = question({ multiSelect: true })
      expect(answerShortName('In place, Leave it', multi)).toBe('2 picked')
      expect(answerShortName('In place, and a note', multi)).toBe('2 picked')
      expect(answerShortName(NONE_ANSWER, multi)).toBe('0 picked')
    })
  })
})
