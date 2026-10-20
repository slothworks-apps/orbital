import { describe, it, expect } from 'vitest'
import { fromClaude } from '../lib/errorRecord'

describe('fromClaude', () => {
  const failed = (message: string, detail: string | null = null) => ({ kind: 'session_failed' as const, message, detail })

  it('recognises a failure that is Claude\'s: the API, a limit, the account', () => {
    expect(fromClaude(failed('API Error: 529 {"type":"overloaded_error"}'))).toBe(true)
    expect(fromClaude(failed('Claude AI usage limit reached|1792512000'))).toBe(true)
    expect(fromClaude(failed('Session ended', 'Error: 429 rate_limit_error'))).toBe(true)
    expect(fromClaude({ kind: 'compaction_failed', message: 'Invalid API key · Please run /login', detail: null })).toBe(true)
  })

  it('leaves Orbital\'s own failures reportable', () => {
    expect(fromClaude(failed('spawn claude ENOENT'))).toBe(false)
    expect(fromClaude(failed('Session exited with code 1 before the first turn finished.'))).toBe(false)
    // Only a session's or a compaction's failure can be Claude's; a request Orbital made is Orbital's.
    expect(fromClaude({ kind: 'api_request', message: 'API Error: 529 overloaded', detail: null })).toBe(false)
  })
})
