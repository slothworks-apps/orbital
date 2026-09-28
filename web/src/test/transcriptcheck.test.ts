import { describe, it, expect } from 'vitest'
import { holdsMessage, transcriptCheckStep } from '../lib/transcriptCheck'
import type { ChatMessage } from '../lib/types'

const msg = (m: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage => m

describe('holdsMessage', () => {
  it('matches a live row to its file copy by role and trimmed text', () => {
    const live = msg({ id: 's:4:0', role: 'assistant', text: 'Done.\n' })
    const file = msg({ id: 'uuid-1:0', role: 'assistant', text: 'Done.' })
    expect(holdsMessage([live], file)).toBe(true)
  })

  it('matches tool rows by the tool call id, not by text', () => {
    const live = msg({ id: 's:5:0', role: 'tool_result', toolUseId: 'toolu_1', text: 'a' })
    const file = msg({ id: 'uuid-2:0', role: 'tool_result', toolUseId: 'toolu_1', text: 'b' })
    const other = msg({ id: 'uuid-3:0', role: 'tool_result', toolUseId: 'toolu_2', text: 'a' })
    expect(holdsMessage([live], file)).toBe(true)
    expect(holdsMessage([live], other)).toBe(false)
  })

  it('does not count a partial row as holding the finished block', () => {
    const streaming = msg({ id: 's:6:0', role: 'assistant', text: 'Hal', partial: true })
    const file = msg({ id: 'uuid-4:0', role: 'assistant', text: 'Hal' })
    expect(holdsMessage([streaming], file)).toBe(false)
    expect(holdsMessage([{ ...streaming, id: file.id }], file)).toBe(false)
  })

  it('does not match across roles', () => {
    const user = msg({ id: 'local:1', role: 'user', text: 'ok' })
    expect(holdsMessage([user], msg({ id: 'u:0', role: 'assistant', text: 'ok' }))).toBe(false)
  })
})

describe('transcriptCheckStep', () => {
  const reply = msg({ id: 'uuid-9:0', role: 'assistant', text: 'The reply' })
  const prompt = msg({ id: 'uuid-8:0', role: 'user', text: 'Question' })

  it('only remembers a first miss — the socket may be a moment behind the file', () => {
    expect(transcriptCheckStep([prompt], [prompt, reply], null)).toEqual({
      reload: false,
      suspect: reply,
    })
  })

  it('reloads when the remembered row is still missing', () => {
    expect(transcriptCheckStep([prompt], [prompt, reply], reply).reload).toBe(true)
  })

  it('reloads on a stale suspect even though the tail has moved on', () => {
    const later = msg({ id: 'uuid-10:0', role: 'assistant', text: 'Later' })
    expect(transcriptCheckStep([prompt], [prompt, reply, later], reply).reload).toBe(true)
  })

  it('forgets the suspect once the socket delivered it', () => {
    const live = { ...reply, id: 's:3:0' }
    expect(transcriptCheckStep([prompt, live], [prompt, reply], reply)).toEqual({
      reload: false,
      suspect: null,
    })
  })

  it('holds the panel only to rows both paths shape alike', () => {
    const thinking = msg({ id: 'uuid-11:0', role: 'thinking', text: '' })
    const slash = msg({ id: 'uuid-12:0', role: 'user', text: '' })
    expect(transcriptCheckStep([prompt], [prompt, thinking], null).suspect).toBeNull()
    expect(transcriptCheckStep([reply], [reply, slash], null).suspect).toBeNull()
  })
})
