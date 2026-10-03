import { describe, expect, it } from 'vitest'
import { composerPlaceholderFor } from '../lib/decisionCard'
import type { PendingDecision, QuestionSpec } from '../lib/types'
import {
  UNNAMED_MAC, composerPlaceholder, footerMode, humanizeError, isDesktopCommand, phoneError,
} from '../mobile/composer'

describe('footerMode', () => {
  it('is the asleep line while the Mac is offline, whatever the session', () => {
    expect(footerMode({ offline: true, macName: 'Studio', readOnly: false })).toEqual({ kind: 'asleep', macName: 'Studio' })
    expect(footerMode({ offline: true, macName: 'Studio', readOnly: true })).toEqual({ kind: 'asleep', macName: 'Studio' })
  })

  it("names the Mac 'Your Mac' when its name is unknown", () => {
    expect(footerMode({ offline: true, macName: null, readOnly: false })).toEqual({ kind: 'asleep', macName: 'Your Mac' })
  })

  it('is the terminal line for a terminal session on a live Mac', () => {
    expect(footerMode({ offline: false, macName: 'Studio', readOnly: true })).toEqual({ kind: 'terminal' })
  })

  it('is the composer for an Orbital session on a live Mac', () => {
    expect(footerMode({ offline: false, macName: null, readOnly: false })).toEqual({ kind: 'composer' })
  })
})

const option = (label: string) => ({ label, description: '' })
const q = (header: string): QuestionSpec => ({
  question: `Which ${header}?`,
  header,
  options: [option('A'), option('B')],
  multiSelect: false,
})
const question = (...questions: QuestionSpec[]): PendingDecision => ({
  id: 'd1',
  kind: 'question',
  input: { questions },
  createdAt: 0,
})
const verdict = (kind: 'permission' | 'plan'): PendingDecision => ({ id: 'd2', kind, input: {}, createdAt: 0 })

describe('composerPlaceholder', () => {
  it('names the first open question and answers it', () => {
    const pending = question(q('Scope'), q('Tests'))
    expect(composerPlaceholder({ pending, answers: { 'Which Scope?': 'A' }, ended: false })).toEqual({
      text: 'Answer Tests, or pick an option above…',
      answering: true,
    })
    expect(composerPlaceholder({ pending, answers: undefined, ended: false }).text).toBe(
      'Answer Scope, or pick an option above…',
    )
  })

  it('falls through to the plain reply once every question is answered', () => {
    const pending = question(q('Scope'))
    expect(composerPlaceholder({ pending, answers: { 'Which Scope?': 'A' }, ended: false })).toEqual({
      text: 'Reply to Claude…',
      answering: false,
    })
  })

  it('says how to refuse a permission or a plan in words', () => {
    expect(composerPlaceholder({ pending: verdict('permission'), answers: undefined, ended: false })).toEqual({
      text: composerPlaceholderFor('permission'),
      answering: true,
    })
    expect(composerPlaceholder({ pending: verdict('plan'), answers: undefined, ended: false })).toEqual({
      text: composerPlaceholderFor('plan'),
      answering: true,
    })
  })

  it('continues an ended session and replies to a live one', () => {
    expect(composerPlaceholder({ pending: undefined, answers: undefined, ended: true })).toEqual({
      text: 'Continue conversation…',
      answering: false,
    })
    expect(composerPlaceholder({ pending: undefined, answers: undefined, ended: false })).toEqual({
      text: 'Reply to Claude…',
      answering: false,
    })
  })
})

describe('isDesktopCommand', () => {
  it("is Orbital's own /rewind and /mcp, sent alone", () => {
    expect(isDesktopCommand('/rewind')).toBe(true)
    expect(isDesktopCommand('  /mcp ')).toBe(true)
  })

  it('is not /compact, an unknown command, or a command inside a message', () => {
    expect(isDesktopCommand('/compact')).toBe(false)
    expect(isDesktopCommand('/rewind please')).toBe(false)
    expect(isDesktopCommand('use /mcp to check')).toBe(false)
  })
})

describe('humanizeError', () => {
  it('words the codes the phone can meet', () => {
    expect(humanizeError('{"error":"local_command"}', 'studio')).toBe('That command needs the desktop app.')
    expect(humanizeError('{"error":"terminal_session"}', 'studio')).toBe('This session is live in a terminal.')
  })

  it('reads any other code with its underscores as spaces', () => {
    expect(humanizeError('{"error":"session_not_running","message":"x"}', 'studio')).toBe('session not running')
  })

  it('names the Mac when the tunnel is down', () => {
    expect(humanizeError('tunnel lost', 'studio')).toBe('studio is unreachable — try again.')
    expect(humanizeError('tunnel offline', null)).toBe(`${UNNAMED_MAC} is unreachable — try again.`)
    expect(humanizeError('tunnel timeout', 'studio')).toBe('studio is unreachable — try again.')
  })

  it('keeps a message that is not a JSON error as it is', () => {
    expect(humanizeError('Session is live in a terminal', 'studio')).toBe('Session is live in a terminal')
    expect(humanizeError('{"message":"no code"}', 'studio')).toBe('{"message":"no code"}')
    expect(humanizeError('42', 'studio')).toBe('42')
  })
})

describe('phoneError', () => {
  it('is the message of an error a request of this client raised', () => {
    expect(phoneError({ kind: 'error', message: 'tunnel lost' })).toBe('tunnel lost')
  })

  it("leaves the errors topic's records, other kinds and no toast alone", () => {
    expect(phoneError({ kind: 'error', message: 'spawn claude ENOENT', source: 'log' })).toBeNull()
    expect(phoneError({ kind: 'info', message: 'saved' })).toBeNull()
    expect(phoneError({ kind: 'rewind_refused', message: 'no' })).toBeNull()
    expect(phoneError(null)).toBeNull()
  })
})
