import { describe, expect, it } from 'vitest'
import {
  isCompleteCode,
  normaliseCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
} from '../src/pairingCode'

describe('normaliseCode', () => {
  it('upper-cases and drops what a pasted code carries along', () => {
    expect(normaliseCode('k7q-4md')).toBe('K7Q4MD')
    expect(normaliseCode(' K7Q 4MD\n')).toBe('K7Q4MD')
    expect(normaliseCode('k7Q–4mD')).toBe('K7Q4MD')
  })

  it('drops characters the alphabet leaves out because they read alike', () => {
    expect(normaliseCode('0O1I')).toBe('')
    expect(normaliseCode('A0B')).toBe('AB')
  })

  it('stops at the code length', () => {
    expect(normaliseCode('ABCDEFGH')).toBe('ABCDEF')
  })

  it('keeps every character of the alphabet', () => {
    expect(normaliseCode(PAIRING_CODE_ALPHABET.toLowerCase())).toBe(
      PAIRING_CODE_ALPHABET.slice(0, PAIRING_CODE_LENGTH),
    )
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[01IO]/)
  })
})

describe('isCompleteCode', () => {
  it('wants all six characters, already normalised', () => {
    expect(isCompleteCode('K7Q4MD')).toBe(true)
    expect(isCompleteCode('K7Q4M')).toBe(false)
    expect(isCompleteCode('k7q4md')).toBe(false)
    expect(isCompleteCode('K7Q4M0')).toBe(false)
  })
})
