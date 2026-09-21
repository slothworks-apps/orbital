import { describe, it, expect } from 'vitest'
import {
  matchModel,
  contextWindowFor,
  modelByValue,
  modelByAnyId,
  modelChipLabel,
  modelNameForId,
  isExactModelMatch,
} from '../lib/models'
import { formatContextWindow } from '../lib/format'
import type { ApiSession, OrbitalModel } from '../lib/types'

const MODELS: OrbitalModel[] = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', family: 'Opus', version: 'Opus 5 with 1M context', shortVersion: 'Opus 5', variant: '1M', blurb: 'Best for everyday, complex tasks', contextWindow: 1_000_000 },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', shortVersion: 'Sonnet 5', variant: null, blurb: 'Efficient for routine tasks', contextWindow: 200_000 },
]

const session = (over: Partial<ApiSession>): ApiSession => ({
  id: 's', cwd: '/w', title: 't', firstAt: null, lastAt: null, messageCount: 0,
  source: 'web', permissionMode: null, model: null, resolvedModel: null,
  parentId: null, mapDismissedAt: null, tagIds: [], status: 'ended', subagents: [], ...over,
})

describe('matchModel', () => {
  it('matches the requested value first', () => {
    expect(matchModel(session({ model: 'sonnet' }), MODELS)?.family).toBe('Sonnet')
  })

  it('matches an exact resolved model', () => {
    expect(matchModel(session({ resolvedModel: 'claude-opus-5[1m]' }), MODELS)?.family).toBe('Opus')
  })

  it('matches a resolved model with the variant suffix stripped', () => {
    // The transcript writes `claude-opus-5` even for a `[1m]` session.
    expect(matchModel(session({ resolvedModel: 'claude-opus-5' }), MODELS)?.family).toBe('Opus')
  })

  it('returns undefined for an unknown model', () => {
    expect(matchModel(session({ resolvedModel: 'claude-something-9' }), MODELS)).toBeUndefined()
  })
})

describe('contextWindowFor', () => {
  it('uses the matched model window', () => {
    expect(contextWindowFor(session({ model: 'opus[1m]' }), MODELS)).toBe(1_000_000)
  })

  it('never widens a window through the stripped suffix', () => {
    // `claude-opus-5` is NOT `claude-opus-5[1m]`; guessing 1M here would draw
    // the bar at a fifth of its real fill. An inexact match stays unknown —
    // the client never re-derives a number the way the server's seed does.
    expect(contextWindowFor(session({ resolvedModel: 'claude-opus-5' }), MODELS)).toBeNull()
  })

  it('is null, not a guess, for a session with no model at all', () => {
    expect(contextWindowFor(session({}), MODELS)).toBeNull()
  })

  it('falls back to the learned map for an exact resolved id no catalog row carries', () => {
    // A revived terminal session: no requested value, and its init-reported
    // id matches no catalog row — but a real turn measured its window
    // (fix: revived-session-shows-no-context-gauge).
    expect(
      contextWindowFor(session({ resolvedModel: 'claude-fable-5' }), MODELS, {
        'claude-fable-5': 1_000_000,
      })
    ).toBe(1_000_000)
  })

  it('never widens through the stripped suffix, even via the learned map', () => {
    // Same rule as the catalog lookup: `claude-opus-5` must not inherit
    // `claude-opus-5[1m]`'s window.
    expect(
      contextWindowFor(session({ resolvedModel: 'claude-opus-5' }), MODELS, {
        'claude-opus-5[1m]': 1_000_000,
      })
    ).toBeNull()
  })
})

describe('modelByValue', () => {
  it('finds a row by its SDK value', () => {
    expect(modelByValue('sonnet', MODELS)?.family).toBe('Sonnet')
    expect(modelByValue(null, MODELS)).toBeUndefined()
  })
})

describe('modelChipLabel', () => {
  it('appends the variant only when there is one', () => {
    expect(modelChipLabel(MODELS[0])).toBe('Opus 5 (1M)')
    expect(modelChipLabel(MODELS[1])).toBe('Sonnet 5')
  })
})

describe('modelByAnyId', () => {
  it('matches an SDK value', () => {
    expect(modelByAnyId('sonnet', MODELS)?.shortVersion).toBe('Sonnet 5')
  })

  it('matches a resolved id a terminal session recorded, exactly or with the variant stripped', () => {
    expect(modelByAnyId('claude-opus-5[1m]', MODELS)?.shortVersion).toBe('Opus 5')
    expect(modelByAnyId('claude-opus-5', MODELS)?.shortVersion).toBe('Opus 5')
  })

  it('matches nothing for an id no row carries', () => {
    expect(modelByAnyId('claude-mystery-1', MODELS)).toBeUndefined()
    expect(modelByAnyId(null, MODELS)).toBeUndefined()
  })
})

describe('modelNameForId', () => {
  it('names an exact resolved id', () => {
    expect(modelNameForId('claude-sonnet-5', MODELS)).toBe('Sonnet 5')
  })

  it('names a resolved id with its variant suffix stripped', () => {
    // The transcript writes `claude-opus-5` even for a `[1m]` session.
    expect(modelNameForId('claude-opus-5', MODELS)).toBe('Opus 5')
  })

  it('falls back to the id itself when nothing matches', () => {
    expect(modelNameForId('claude-mystery-1', MODELS)).toBe('claude-mystery-1')
  })
})

describe('isExactModelMatch', () => {
  const session = (over: Partial<ApiSession>): ApiSession => ({
    id: 's', cwd: '/w', title: 't', firstAt: null, lastAt: null, messageCount: 0,
    source: 'web', permissionMode: null, model: null, resolvedModel: null,
    parentId: null, mapDismissedAt: null, tagIds: [], status: 'ended', subagents: [], ...over,
  })

  it('is exact when the session names the row by its requested value', () => {
    expect(isExactModelMatch(session({ model: 'opus[1m]' }), MODELS[0])).toBe(true)
  })

  it('is exact when the resolved model matches the row exactly', () => {
    expect(isExactModelMatch(session({ resolvedModel: 'claude-opus-5[1m]' }), MODELS[0])).toBe(true)
  })

  it('is not exact when only the variant-stripped resolved model matches', () => {
    expect(isExactModelMatch(session({ resolvedModel: 'claude-opus-5' }), MODELS[0])).toBe(false)
  })
})

describe('formatContextWindow', () => {
  it('formats in the canvas notation', () => {
    expect(formatContextWindow(200_000)).toBe('200k')
    expect(formatContextWindow(1_000_000)).toBe('1M')
    expect(formatContextWindow(1_500_000)).toBe('1.5M')
  })
})
