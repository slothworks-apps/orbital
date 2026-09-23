import { describe, it, expect } from 'vitest'
import type { PendingVerdictDecision } from '../lib/types'
import {
  DECLINE_TEXT_CAP,
  composerHintFor,
  composerPlaceholderFor,
  declineVerdict,
  decisionChipLabel,
  decisionHeadline,
  inputDetail,
  inputSummary,
  planText,
} from '../lib/decisionCard'

/**
 * The permission/plan card's pure logic (spec:
 * 2026-09-23-permission-and-plan-decisions-design § Testing). Nothing here
 * asserts pixels or copy the canvas owns — only the rules: which text the
 * card is allowed to claim came from the CLI, and what a refusal actually
 * posts.
 */

function decision(overrides: Partial<PendingVerdictDecision> = {}): PendingVerdictDecision {
  return {
    id: 'tu1',
    kind: 'permission',
    toolName: 'Bash',
    input: { command: 'rm -rf build' },
    createdAt: 1,
    ...overrides,
  }
}

describe('decisionHeadline', () => {
  it('prefers the CLI bridge’s own sentence', () => {
    expect(decisionHeadline(decision({ title: 'Claude wants to run rm -rf build' }))).toBe(
      'Claude wants to run rm -rf build',
    )
  })

  it('falls back to the tool name rather than quoting the input', () => {
    const line = decisionHeadline(decision())
    expect(line).toContain('Bash')
    // The fallback must not guess how much of a command is safe to show
    // inline; the detail block below the headline shows the input in full.
    expect(line).not.toContain('rm -rf build')
  })

  it('ignores a blank title, and still names a tool-less ask', () => {
    expect(decisionHeadline(decision({ title: '   ' }))).toContain('Bash')
    expect(decisionHeadline(decision({ title: '  ', toolName: undefined }))).toBeTruthy()
  })

  it('says what a plan approval is about without a tool name', () => {
    const line = decisionHeadline(decision({ kind: 'plan', toolName: 'ExitPlanMode' }))
    expect(line.toLowerCase()).toContain('plan')
  })
})

describe('decisionChipLabel', () => {
  it('names the kind, not the tool', () => {
    expect(decisionChipLabel('permission')).toBe('PERMISSION')
    expect(decisionChipLabel('plan')).toBe('PLAN')
  })
})

describe('planText', () => {
  it('reads the plan out of an ExitPlanMode input', () => {
    expect(planText({ plan: '# Plan\n1. go' })).toBe('# Plan\n1. go')
  })

  it('is null for a call that carries no plan, so the card falls back', () => {
    // The CLI can save the plan to a file instead of inlining it; an empty
    // plan block is worse than no plan block.
    expect(planText({})).toBeNull()
    expect(planText({ plan: '   ' })).toBeNull()
    expect(planText({ plan: 42 })).toBeNull()
  })
})

describe('inputSummary', () => {
  it('picks the field that says what is about to happen', () => {
    expect(inputSummary({ command: 'ls', description: 'list' })).toBe('ls')
    expect(inputSummary({ file_path: '/w/a.ts' })).toBe('/w/a.ts')
    expect(inputSummary({ url: 'https://example.com' })).toBe('https://example.com')
  })

  it('prefers the action over the place when a tool carries both', () => {
    expect(inputSummary({ file_path: '/w/a.ts', command: 'cat a.ts' })).toBe('cat a.ts')
  })

  it('is null when a tool takes none of them — most MCP tools', () => {
    expect(inputSummary({ issueId: 7 })).toBeNull()
    expect(inputSummary({ command: '   ' })).toBeNull()
    expect(inputSummary({})).toBeNull()
  })
})

describe('inputDetail', () => {
  it('renders an input as pretty JSON', () => {
    expect(inputDetail({ a: 1 })).toBe('{\n  "a": 1\n}')
  })

  it('is null for an empty input — nothing to show is not a block', () => {
    expect(inputDetail({})).toBeNull()
  })

  it('survives an input that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(inputDetail(cyclic)).toBeTruthy()
  })
})

describe('declineVerdict', () => {
  it('carries the reason to the model', () => {
    expect(declineVerdict('run the tests first')).toEqual({
      approved: false,
      message: 'run the tests first',
    })
  })

  it('sends no message at all for blank text', () => {
    // A blank string would REPLACE the server's own wording for a bare
    // refusal with nothing, which is not what an empty field meant.
    expect(declineVerdict('   ')).toEqual({ approved: false })
    expect(declineVerdict('')).toEqual({ approved: false })
  })

  it('never approves, whatever it is handed', () => {
    expect(declineVerdict('yes please').approved).toBe(false)
  })

  it('caps the reason', () => {
    const message = declineVerdict('x'.repeat(DECLINE_TEXT_CAP + 50)).message
    expect(message).toHaveLength(DECLINE_TEXT_CAP)
  })
})

describe('the composer while a verdict decision is parked', () => {
  it('says typing declines rather than approves', () => {
    // The one thing the hint MUST get across: ⏎ is not a yes.
    for (const kind of ['permission', 'plan'] as const) {
      expect(composerHintFor(kind)).not.toMatch(/approve|allow/i)
      expect(composerPlaceholderFor(kind)).toBeTruthy()
    }
    expect(composerHintFor('permission')).toMatch(/decline/i)
  })
})
