import { beforeEach, describe, expect, it } from 'vitest'
import {
  breakdownSections,
  categorySlots,
  contextReportView,
  formatShare,
  formatReportTokens,
  isContextCommand,
  shortenMemoryPath,
} from '../lib/contextReport'
import type { ChatMessage, ContextReport } from '../lib/types'
import { isContextAnswer, useContextReport } from '../store/contextReport'

const THRESHOLDS = { warn: 50, critical: 80 }

function report(over: Partial<ContextReport> = {}): ContextReport {
  return {
    model: 'claude-opus-5-5[1m]',
    totalTokens: 108805,
    rawMaxTokens: 1000000,
    percentage: 11,
    categories: [
      { name: 'System prompt', tokens: 2758, kind: 'used' },
      { name: 'System tools', tokens: 1324, kind: 'used' },
      { name: 'MCP tools', tokens: 654, kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 25954, kind: 'deferred' },
      { name: 'Custom agents', tokens: 0, kind: 'used' },
      { name: 'Messages', tokens: 84421, kind: 'used' },
      { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
      { name: 'Free space', tokens: 858195, kind: 'free' },
    ],
    mcpTools: [],
    memoryFiles: [],
    agents: [],
    skills: [],
    ...over,
  }
}

describe('isContextCommand', () => {
  it('matches /context with or without arguments, and nothing that only starts like it', () => {
    expect(isContextCommand('/context')).toBe(true)
    expect(isContextCommand('  /context  ')).toBe(true)
    expect(isContextCommand('/context all')).toBe(true)
    expect(isContextCommand('/contexts')).toBe(false)
    expect(isContextCommand('what is /context')).toBe(false)
  })
})

describe('formatReportTokens', () => {
  it('writes tokens the way the printout does', () => {
    expect(formatReportTokens(654)).toBe('654')
    expect(formatReportTokens(999)).toBe('999')
    expect(formatReportTokens(1000)).toBe('1k')
    expect(formatReportTokens(2758)).toBe('2.8k')
    expect(formatReportTokens(108805)).toBe('108.8k')
    expect(formatReportTokens(1000000)).toBe('1M')
  })

  it('never writes 1000k', () => {
    expect(formatReportTokens(999960)).toBe('1M')
    expect(formatReportTokens(999940)).toBe('999.9k')
  })
})

describe('formatShare', () => {
  it('rounds small shares to a decimal, large ones to whole percents', () => {
    expect(formatShare(2758, 1e6)).toBe('0.3 %')
    expect(formatShare(654, 1e6)).toBe('<0.1 %')
    expect(formatShare(858195, 1e6)).toBe('86 %')
    expect(formatShare(0, 1e6)).toBe('0 %')
    expect(formatShare(5, 0)).toBe('0 %')
  })
})

describe('categorySlots', () => {
  it('gives a known category its own slot, whichever others are present', () => {
    expect(categorySlots(['System prompt', 'Messages'])).toEqual([1, 7])
    expect(categorySlots(['MCP tools', 'Skills'])).toEqual([3, 6])
  })

  it('gives a category the CLI added a slot no known one in the report holds', () => {
    expect(categorySlots(['System prompt', 'Pinned files', 'System tools', 'Messages'])).toEqual([1, 3, 2, 7])
  })
})

describe('shortenMemoryPath', () => {
  it('writes home as ~ and keeps the file and its folder', () => {
    expect(shortenMemoryPath('/Users/me/.claude/CLAUDE.md')).toBe('~/.claude/CLAUDE.md')
    expect(shortenMemoryPath('/Users/me/work/orbital/.claude/rules/design-tokens.md')).toBe('~/…/rules/design-tokens.md')
    expect(shortenMemoryPath('/home/me/work/orbital/app/CLAUDE.md')).toBe('~/…/app/CLAUDE.md')
  })

  it('leaves a path outside home whole when it is short', () => {
    expect(shortenMemoryPath('/etc/claude/CLAUDE.md')).toBe('/etc/claude/CLAUDE.md')
  })
})

describe('contextReportView', () => {
  it('splits the categories by kind: used to the chart, buffer and free beside it, deferred apart', () => {
    const view = contextReportView(report(), THRESHOLDS)
    expect(view.used.map((c) => [c.name, c.slot])).toEqual([
      ['System prompt', 1],
      ['System tools', 2],
      ['MCP tools', 3],
      ['Messages', 7],
    ])
    expect(view.reserve).toEqual([
      { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
      { name: 'Free space', tokens: 858195, kind: 'free' },
    ])
    expect(view.deferred).toEqual([{ name: 'MCP tools (deferred)', tokens: 25954 }])
    expect(view.fill).toBeCloseTo(0.1088)
    expect(view.buffer).toBeCloseTo(0.033)
    expect(view.level).toBe('ok')
    expect(view.spills).toBe(false)
    expect(view.overLine).toBeNull()
  })

  it('keeps a category of an unknown kind in the legend, outside the chart', () => {
    const view = contextReportView(
      report({ categories: [{ name: 'Messages', tokens: 10, kind: 'used' }, { name: 'Pinned', tokens: 4, kind: 'pinned' }] }),
      THRESHOLDS,
    )
    expect(view.used.map((c) => c.name)).toEqual(['Messages'])
    expect(view.reserve).toEqual([{ name: 'Pinned', tokens: 4, kind: 'other' }])
  })

  it('steps the level at the thresholds the settings hold', () => {
    expect(contextReportView(report({ totalTokens: 640000 }), THRESHOLDS).level).toBe('warn')
    expect(contextReportView(report({ totalTokens: 870000 }), THRESHOLDS).level).toBe('critical')
    expect(contextReportView(report({ totalTokens: 640000 }), { warn: 70, critical: 90 }).level).toBe('ok')
  })

  it('says how far over the window it is, in the words of the kind', () => {
    const past = contextReportView(
      report({ totalTokens: 204500, rawMaxTokens: 200000, overLimit: { tokensOver: 4500, kind: 'compaction_window' } }),
      THRESHOLDS,
    )
    expect(past.overLine).toBe('4.5k past the compaction point')
    expect(past.windowNoun).toBe('tokens in the compaction window')
    expect(past.fill).toBe(1)
    expect(past.spills).toBe(true)
    const hard = contextReportView(report({ overLimit: { tokensOver: 12000, kind: 'hard_limit' } }), THRESHOLDS)
    expect(hard.overLine).toBe('12k over the model’s limit')
  })
})

describe('breakdownSections', () => {
  it('groups MCP tools by server, heaviest first, without the server prefix', () => {
    const [mcp] = breakdownSections(
      report({
        mcpTools: [
          { name: 'mcp__atlas__docs_read', serverName: 'atlas', tokens: 96 },
          { name: 'mcp__github__create_issue', serverName: 'github', tokens: 300 },
          { name: 'mcp__atlas__docs_create', serverName: 'atlas', tokens: 286 },
          { name: 'mcp__github__list_issues', serverName: '', tokens: 50 },
        ],
      }),
    )
    expect(mcp.sub).toBe('4 tools · 2 servers')
    expect(mcp.tokens).toBe(732)
    expect(mcp.groups.map((g) => [g.lead, g.tag, g.tokens])).toEqual([
      ['atlas', '2 tools', 382],
      ['github', '2 tools', 350],
    ])
    expect(mcp.groups[0].items).toEqual([
      { name: 'docs_create', tokens: 286 },
      { name: 'docs_read', tokens: 96 },
    ])
    expect(mcp.groups[0].share).toBe(1)
    expect(mcp.groups[1].share).toBeCloseTo(350 / 382)
  })

  it('groups skills by plugin, or by source where there is none', () => {
    const [skills] = breakdownSections(
      report({
        skills: [
          { name: 'superpowers:brainstorming', source: 'plugin', pluginName: 'superpowers', tokens: 40 },
          { name: 'dataviz', source: 'built-in', tokens: 482 },
          { name: 'superpowers:writing-plans', source: 'plugin', pluginName: 'superpowers', tokens: 60 },
          { name: 'atlas-adopt', source: 'userSettings', tokens: 66 },
        ],
      }),
    )
    expect(skills.sub).toBe('4 skills · 3 sources')
    expect(skills.groups.map((g) => [g.lead, g.tokens])).toEqual([
      ['Built-in', 482],
      ['superpowers', 100],
      ['User', 66],
    ])
    expect(skills.groups[1].items.map((i) => i.name)).toEqual(['writing-plans', 'brainstorming'])
  })

  it('sorts the sections by their totals and leaves an empty one out', () => {
    const sections = breakdownSections(
      report({
        memoryFiles: [
          { path: '/Users/me/.claude/CLAUDE.md', type: 'User', tokens: 142 },
          { path: '/Users/me/work/orbital/CLAUDE.md', type: 'Project', tokens: 4131 },
        ],
        agents: [{ agentType: 'code-reviewer', source: 'userSettings', tokens: 92 }],
      }),
    )
    expect(sections.map((s) => s.key)).toEqual(['memory', 'agents'])
    expect(sections[0].sub).toBe('2 files')
    expect(sections[0].groups.map((g) => [g.lead, g.full, g.tag])).toEqual([
      ['~/work/orbital/CLAUDE.md', '/Users/me/work/orbital/CLAUDE.md', 'Project'],
      ['~/.claude/CLAUDE.md', '/Users/me/.claude/CLAUDE.md', 'User'],
    ])
    expect(sections[1].sub).toBe('1 agent')
    expect(sections[1].groups[0].tag).toBe('User')
  })
})

describe('opening by itself', () => {
  const answer = (over: Partial<NonNullable<ChatMessage['notice']>> = {}): ChatMessage => ({
    id: 'n1',
    role: 'notice',
    text: '## Context Usage',
    notice: { level: 'notice', command: '/context', contextReport: report(), ...over },
  })

  beforeEach(() => useContextReport.setState({ open: null, asked: {}, onScreen: null, taking: null }))

  it('opens the answer to a /context sent from here while its session is on screen', () => {
    useContextReport.getState().view('s1')
    useContextReport.getState().ask('s1')
    useContextReport.getState().answered('s1', answer())
    expect(useContextReport.getState().open?.key).toBe('n1')
    expect(useContextReport.getState().asked).toEqual({})
  })

  it('leaves an answer nobody here asked for closed, and one for another session', () => {
    useContextReport.getState().view('s1')
    useContextReport.getState().answered('s1', answer())
    useContextReport.getState().ask('s2')
    useContextReport.getState().answered('s1', answer())
    expect(useContextReport.getState().open).toBeNull()
    expect(useContextReport.getState().asked).toEqual({ s2: true })
  })

  it('settles the ask but stays closed when the session is no longer on screen', () => {
    const leave = useContextReport.getState().view('s1')
    useContextReport.getState().ask('s1')
    leave()
    useContextReport.getState().view('s2')
    useContextReport.getState().answered('s1', answer())
    expect(useContextReport.getState().open).toBeNull()
    expect(useContextReport.getState().asked).toEqual({})
    // Back on the session, a later answer from elsewhere does not open either.
    useContextReport.getState().view('s1')
    useContextReport.getState().answered('s1', answer())
    expect(useContextReport.getState().open).toBeNull()
  })

  it('stays closed while nothing is on screen (a pushed screen, a lock)', () => {
    const leave = useContextReport.getState().view('s1')
    useContextReport.getState().ask('s1')
    leave()
    useContextReport.getState().answered('s1', answer())
    expect(useContextReport.getState().open).toBeNull()
  })

  it('leaving a session does not take the screen from the one that replaced it', () => {
    const leaveFirst = useContextReport.getState().view('s1')
    useContextReport.getState().view('s2')
    leaveFirst()
    expect(useContextReport.getState().onScreen).toBe('s2')
  })

  it('settles the ask on an answer without a report, so the next one from elsewhere stays closed', () => {
    useContextReport.getState().view('s1')
    useContextReport.getState().ask('s1')
    useContextReport.getState().answered('s1', answer({ contextReport: undefined }))
    expect(useContextReport.getState().open).toBeNull()
    useContextReport.getState().answered('s1', answer())
    expect(useContextReport.getState().open).toBeNull()
  })

  it('forgets a /context that did not go out', () => {
    useContextReport.getState().view('s1')
    useContextReport.getState().ask('s1')
    useContextReport.getState().forget('s1')
    useContextReport.getState().answered('s1', answer())
    expect(useContextReport.getState().open).toBeNull()
  })

  it('forgets every ask at once, as a reconnect does', () => {
    useContextReport.getState().view('s1')
    useContextReport.getState().ask('s1')
    useContextReport.getState().ask('s2')
    useContextReport.getState().forgetAll()
    useContextReport.getState().answered('s1', answer())
    expect(useContextReport.getState().open).toBeNull()
    expect(useContextReport.getState().asked).toEqual({})
  })

  it('knows a /context answer by its command or by its report', () => {
    expect(isContextAnswer(answer())).toBe(true)
    expect(isContextAnswer(answer({ command: undefined }))).toBe(true)
    expect(isContextAnswer(answer({ command: '/usage', contextReport: undefined }))).toBe(false)
    expect(isContextAnswer({ id: 'u', role: 'user', text: '/context' })).toBe(false)
  })
})
