import { describe, expect, it } from 'vitest'
import { SESSION_BEATS, frameFor, transcriptChange } from './scenario'

const beats = SESSION_BEATS.map((_, beat) => beat)

describe('the session scenario', () => {
  it('asks only in its first beat, and the transcript draws the card in place of the call it asks about', () => {
    for (const beat of beats) {
      const { session, messages } = frameFor(beat, 0)
      if (beat === 0) {
        expect(session.status).toBe('needs_input')
        expect(messages.some((m) => m.role === 'tool_use' && m.toolUseId === session.pendingDecision?.id)).toBe(true)
      } else {
        expect(session.pendingDecision).toBeNull()
      }
    }
  })

  it('within a round only adds rows at the end, so each beat is told as new messages', () => {
    for (const beat of beats.slice(1)) {
      const change = transcriptChange(frameFor(beat - 1, 0).messages, frameFor(beat, 0).messages)
      expect(change.kind).toBe('append')
    }
  })

  it('starting over is a reset, and asks under a new id', () => {
    const last = frameFor(beats.length - 1, 0)
    const next = frameFor(0, 1)
    expect(transcriptChange(last.messages, next.messages)).toEqual({ kind: 'reset' })
    expect(next.session.pendingDecision?.id).not.toBe(frameFor(0, 0).session.pendingDecision?.id)
  })

  it('gives every row of a frame its own id', () => {
    for (const beat of beats) {
      const ids = frameFor(beat, 3).messages.map((m) => m.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})
