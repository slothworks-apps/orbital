import { describe, it, expect } from 'vitest'
import type { QuestionSpec } from '../lib/types'
import {
  NONE_ANSWER,
  activeQuestionIndex,
  chipLabel,
  completedAnswers,
  confirmLabel,
  isComplete,
  isOtherRow,
  joinSelection,
  moveFocus,
  notTakenLine,
  openQuestion,
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
    expect(openQuestion(questions, answers)).toBe(tests)
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
    expect(openQuestion(questions, answers)).toBeUndefined()
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
})
